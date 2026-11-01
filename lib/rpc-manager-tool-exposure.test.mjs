import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, resolveActiveToolNames } = await jiti.import("./rpc-manager.ts");
const { TOOL_SELECTION_TYPE } = await jiti.import("./session-tool-selection.ts");
const { SUBAGENT_META_TYPE } = await jiti.import("./subagents.ts");
const { localToolPolicy, localToolCallBlockReason } = await jiti.import("./local-tool-modes.ts");
const { createReadOnlyMcpPolicyExtension } = await jiti.import("./mcp-read-only-policy.ts");
const PLAN = ["read", "grep", "find", "ls"];
const BUILD = ["read", "bash", "edit", "write"];
const FULL = [...BUILD, "grep", "find", "ls"];
const definitions = [
  ...FULL.map((name) => ({ name, description: name })),
  { name: "lookup", description: "extension" },
  { name: "codemode", description: "inactive", exposure: "model-only" },
  { name: "scripted", description: "script tool", exposure: "codemode" },
  { name: "searchable", description: "search tool", exposure: "deferred" },
  { name: "withdrawn", description: "hidden", exposure: "hidden" },
  { name: "subagent", description: "In plan/build, children cannot load extensions or MCP" },
  { name: "webfetch", description: "Read-only webfetch: fetch", annotations: { readOnlyHint: true } },
];
const pin = (tools) => ({ type: "custom", customType: TOOL_SELECTION_TYPE, data: { version: 1, tools } });

function makeWrapper({ entries = [], active = [...FULL, "lookup"], tools = definitions, ...overrides } = {}, options = {}) {
  const state = { active: [...active], activations: [] };
  const inner = {
    sessionId: "local-modes", sessionFile: undefined,
    isStreaming: false, isCompacting: false, isBashRunning: false,
    sessionManager: { getCwd: () => process.cwd(), getEntries: () => entries },
    settingsManager: { getDefaultTools: () => ["+codemode"], setProjectTrusted: () => {} },
    agent: { state: {} },
    extensionRunner: { emit: async () => {}, setUIContext: () => {} },
    subscribe: () => () => {},
    getAllTools: () => tools,
    getActiveToolNames: () => [...state.active],
    setActiveToolsByName: (names) => {
      state.activations.push(names);
      state.active = names.filter((name) => tools.some((tool) => tool.name === name && tool.exposure !== "hidden"));
    },
    reload: async () => { state.active = [...FULL, "lookup", "codemode"]; },
    navigateTree: async () => { state.active = [...FULL, "lookup"]; return { cancelled: false }; },
    dispose: () => {}, ...overrides,
  };
  return { inner, state, wrapper: new AgentSessionWrapper(inner, options), entries };
}

for (const [name, selected, expected] of [
  ["plan", PLAN, [...PLAN, "subagent", "webfetch"]],
  ["build", BUILD, [...BUILD, "subagent", "webfetch"]],
  ["full", FULL, definitions.filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name)],
  ["none", [], []],
]) {
  test(`${name} selection uses the local source policy`, (t) => {
    const { inner, wrapper, state } = makeWrapper();
    t.after(() => wrapper.destroy());
    assert.deepEqual(resolveActiveToolNames(inner, selected, ["lookup", "withdrawn", "gone"]), expected);
    wrapper.setActiveToolSelection(selected);
    assert.deepEqual(state.active, expected);
  });
}

test("Web builtin host selection survives reload, navigation, and get_tools without activating legacy subagent", async (t) => {
  const host = ["Agent", "get_subagent_result", "steer_subagent"].map((name) => ({ name, description: "host", exposure: "model-only", sourceInfo: { path: "<inline:pi-web-subagents>" } }));
  for (const selection of [undefined, PLAN, BUILD, FULL]) {
    const tools = [...definitions, ...host];
    const { wrapper, state } = makeWrapper({ entries: selection ? [pin(selection)] : [], tools });
    t.after(() => wrapper.destroy());
    const assertActive = () => {
      for (const tool of host) assert.ok(state.active.includes(tool.name));
      assert.ok(!state.active.includes("subagent"));
      assert.ok(state.active.includes("webfetch"));
    };
    await wrapper.waitUntilReady();
    assertActive();
    await wrapper.send({ type: "get_tools" });
    assertActive();
    await wrapper.send({ type: "reload" });
    assertActive();
    await wrapper.createExtensionCommandContextActions().reload();
    assertActive();
    await wrapper.send({ type: "navigate_tree", targetId: "old" });
    assertActive();
  }
});

test("no selection and cleared selection restore build at ready/get_tools/reload/navigation", async (t) => {
  for (const entries of [[], [pin(PLAN), { type: "custom", customType: TOOL_SELECTION_TYPE, data: { version: 1, cleared: true } }]]) {
    const { wrapper, state } = makeWrapper({ entries });
    t.after(() => wrapper.destroy());
    await wrapper.waitUntilReady();
    assert.deepEqual(state.active, [...BUILD, "subagent", "webfetch"]);
    state.active = [...FULL, "lookup"];
    const tools = await wrapper.send({ type: "get_tools" });
    assert.deepEqual(tools.filter((tool) => tool.active).map((tool) => tool.name), [...BUILD, "subagent", "webfetch"]);
    await wrapper.send({ type: "reload" });
    assert.deepEqual(state.active, [...BUILD, "subagent", "webfetch"]);
    await wrapper.createExtensionCommandContextActions().reload();
    assert.deepEqual(state.active, [...BUILD, "subagent", "webfetch"]);
    await wrapper.send({ type: "navigate_tree", targetId: "old" });
    assert.deepEqual(state.active, [...BUILD, "subagent", "webfetch"]);
  }
});

// Upstream #1405: compare actual declaration order, not sorted membership. The
// upstream unpinned/defaultTools cases intentionally become default-build here.
for (const [name, selected, declared] of [
  ["plan", PLAN, ["webfetch", "ls", "subagent", "find", "read", "grep"]],
  ["build", BUILD, ["subagent", "edit", "webfetch", "write", "read", "bash"]],
  ["default build", undefined, ["webfetch", "write", "read", "subagent", "bash", "edit"]],
  ["full", FULL, definitions.filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name).reverse()],
  ["legacy subset", ["read", "bash", "edit", "write", "grep", "find"], ["read", "bash", "edit", "write", "codemode", "grep", "find"]],
]) {
  for (const commandContext of [false, true]) {
    test(`${name} keeps order through ${commandContext ? "extension" : "RPC"} navigation and every reassertion`, async (t) => {
      for (const reordered of [false, true]) {
        const made = makeWrapper({
          entries: selected ? [pin(selected)] : [], active: declared,
          navigateTree: async () => {
            made.state.active = reordered ? [...declared].reverse() : [...declared];
            return { cancelled: false };
          },
          prompt: async (_text, options) => {
            // The inline policy's actual before_agent_start path, with no model/provider.
            const handlers = new Map();
            createReadOnlyMcpPolicyExtension(() => ["+codemode"]).factory({
              on: (event, handler) => handlers.set(event, handler),
              getAllTools: made.inner.getAllTools,
              getActiveTools: made.inner.getActiveToolNames,
              setActiveTools: made.inner.setActiveToolsByName,
            });
            const event = { type: "before_agent_start", systemPromptOptions: { selectedTools: ["lookup"], promptGuidelines: [] } };
            handlers.get("before_agent_start")(event, { sessionManager: made.inner.sessionManager });
            assert.deepEqual(event.systemPromptOptions.selectedTools, declared);
            assert.deepEqual(made.state.active, declared);
            options.preflightResult("handled");
          },
        });
        t.after(() => made.wrapper.destroy());
        if (commandContext) await made.wrapper.createExtensionCommandContextActions().navigateTree("same");
        else await made.wrapper.send({ type: "navigate_tree", targetId: "same" });
        assert.deepEqual(made.state.activations, reordered ? [declared] : []);
        assert.deepEqual(made.state.active, declared);
        await made.wrapper.waitUntilReady();
        assert.deepEqual(made.state.active, declared);
        await made.wrapper.send({ type: "get_tools" });
        assert.deepEqual(made.state.active, declared);
        await made.wrapper.send({ type: "prompt", message: "fixture" });
        assert.deepEqual(made.state.active, declared);
      }
    });
  }
}

test("SDK 1.4 navigation and before_agent_start preserve actual ordered declarations after sanitizing defaults", async (t) => {
  const { fauxAssistantMessage, fauxProvider, fauxText } = await import("@earendil-works/pi-ai");
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { appendSessionToolSelection } = await jiti.import("./session-tool-selection.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-web-ordered-loadout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const selected of [undefined, PLAN, BUILD, FULL]) {
    const faux = fauxProvider({ models: [{ id: "ordered-tools" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        { name: "ordered-fixtures", factory: (pi) => {
          for (const tool of definitions.filter((tool) => ["lookup", "subagent", "webfetch"].includes(tool.name))) {
            pi.registerTool({ ...tool, label: tool.name, parameters: { type: "object" },
              execute: async () => { throw new Error("fixture must not execute"); },
            });
          }
        } },
        createReadOnlyMcpPolicyExtension(),
      ],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(dir);
    if (selected) appendSessionToolSelection(sessionManager, selected);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime,
      model: faux.getModel("ordered-tools"), sessionManager, settingsManager, resourceLoader,
    });
    const wrapper = new AgentSessionWrapper(session);
    try {
      await wrapper.waitUntilReady();
      const canonical = session.getActiveToolNames();
      const declared = [...canonical].reverse();
      const prompt = async (message) => {
        faux.setResponses([() => fauxAssistantMessage([fauxText("fixture done")])]);
        await session.prompt(message);
      };
      await prompt("first loadout");
      const firstLeaf = sessionManager.getLeafId();
      session.setActiveToolsByName(declared);
      await prompt("same allowed set, different order");
      assert.deepEqual(session.getActiveToolNames(), declared);
      assert.deepEqual(session.agent.state.tools.map((tool) => tool.name), declared);
      await wrapper.send({ type: "navigate_tree", targetId: firstLeaf });
      assert.deepEqual(session.getActiveToolNames(), declared);
      await wrapper.waitUntilReady();
      await wrapper.send({ type: "get_tools" });
      assert.deepEqual(session.getActiveToolNames(), declared);
      await prompt("after navigation");
      assert.deepEqual(session.agent.state.tools.map((tool) => tool.name), declared);
      if (selected !== FULL) assert.ok(!session.getActiveToolNames().includes("lookup"));
    } finally {
      await wrapper.shutdown();
    }
  }
});

test("equal raw restored sets never bypass sanitization or the target branch's pin", async (t) => {
  for (const selected of [undefined, PLAN, BUILD, FULL, []]) {
    const entries = selected ? [pin(selected)] : [];
    // Both sets match, but contain forbidden/withdrawn/unknown tools and omit
    // permitted ones. SDK 1.4 can restore these and add extension defaults.
    const raw = ["lookup", "read", "withdrawn", "gone", "codemode"];
    const made = makeWrapper({ entries, active: raw, navigateTree: async () => {
      made.state.active = [...raw].reverse();
      return { cancelled: false };
    } });
    t.after(() => made.wrapper.destroy());
    await made.wrapper.send({ type: "navigate_tree", targetId: "unsafe" });
    const expected = localToolPolicy(selected, definitions, raw).active;
    assert.deepEqual(made.state.active, expected);
    assert.ok(!made.state.active.includes("withdrawn"));
    assert.ok(!made.state.active.includes("gone"));
    if (selected !== FULL) {
      for (const toolName of ["lookup", "codemode", "scripted", "searchable"]) {
        assert.ok(!made.state.active.includes(toolName));
        assert.ok(localToolCallBlockReason(localToolPolicy(selected, definitions, raw), definitions, toolName, {}));
      }
    }
  }
});

test("navigation preserves the previous order when only sanitization makes the sets match", async (t) => {
  for (const selected of [undefined, PLAN, BUILD]) {
    const allowed = localToolPolicy(selected, definitions).active.reverse();
    const made = makeWrapper({ entries: selected ? [pin(selected)] : [], active: allowed, navigateTree: async () => {
      made.state.active = [...allowed].reverse().concat("lookup", "codemode", "scripted");
      return { cancelled: false };
    } });
    t.after(() => made.wrapper.destroy());
    await made.wrapper.send({ type: "navigate_tree", targetId: "extras" });
    assert.deepEqual(made.state.active, allowed);
    await made.wrapper.send({ type: "get_tools" });
    assert.deepEqual(made.state.active, allowed);
  }
});

test("navigation resolves a changed target pin before deciding whether to keep order", async (t) => {
  const entries = [pin(BUILD)];
  const raw = ["write", "edit", "read", "bash", "subagent", "webfetch"];
  const made = makeWrapper({ entries, active: raw, navigateTree: async () => {
    entries.push(pin(PLAN));
    made.state.active = [...raw];
    return { cancelled: false };
  } });
  t.after(() => made.wrapper.destroy());
  await made.wrapper.send({ type: "navigate_tree", targetId: "plan" });
  assert.deepEqual(made.state.active, [...PLAN, "subagent", "webfetch"]);
});

test("both reload paths restore local policy and invalidate the shared model runtime", async (t) => {
  const previousRuntime = globalThis.__piWebSharedModelRuntime;
  t.after(() => { globalThis.__piWebSharedModelRuntime = previousRuntime; });
  for (const selected of [undefined, PLAN]) {
    for (const commandContext of [false, true]) {
      const { wrapper, state } = makeWrapper({ entries: selected ? [pin(selected)] : [] });
      t.after(() => wrapper.destroy());
      globalThis.__piWebSharedModelRuntime = { fixture: true };
      if (commandContext) await wrapper.createExtensionCommandContextActions().reload();
      else await wrapper.send({ type: "reload" });
      assert.deepEqual(state.active, [...(selected ?? BUILD), "subagent", "webfetch"]);
      assert.equal(globalThis.__piWebSharedModelRuntime, undefined);
    }
  }
});

test("pins survive reload and both navigation paths", async (t) => {
  const { wrapper, state } = makeWrapper({ entries: [pin(PLAN)] });
  t.after(() => wrapper.destroy());
  for (const action of [
    () => wrapper.send({ type: "reload" }),
    () => wrapper.send({ type: "navigate_tree", targetId: "old" }),
    () => wrapper.createExtensionCommandContextActions().navigateTree("old"),
  ]) {
    await action();
    assert.deepEqual(state.active, [...PLAN, "subagent", "webfetch"]);
  }
});

test("only nonhidden, marked subagent and annotated/marked webfetch are admitted", () => {
  for (const change of [
    { name: "subagent", description: "older implementation" },
    { name: "subagent", description: definitions.at(-2).description, exposure: "hidden" },
    { name: "webfetch", description: "fetch", annotations: { readOnlyHint: true } },
    { name: "webfetch", description: "Read-only webfetch: fetch" },
    { name: "webfetch", description: "Read-only webfetch: fetch", annotations: { readOnlyHint: false } },
    { ...definitions.at(-1), exposure: "hidden" },
  ]) {
    const tools = definitions.map((tool) => tool.name === change.name ? change : tool);
    const policy = localToolPolicy(PLAN, tools);
    assert.ok(!policy.active.includes(change.name));
    assert.ok(localToolCallBlockReason(policy, tools, change.name, {}));
  }
});

test("legacy subsets keep carry but cannot execute arbitrary deferred extensions; none blocks everything", () => {
  const policy = localToolPolicy(["read"], definitions, ["lookup", "searchable", "withdrawn"]);
  assert.deepEqual(policy.active, ["read", "lookup", "searchable"]);
  assert.equal(localToolCallBlockReason(policy, definitions, "read", {}), undefined);
  for (const name of ["bash", "lookup", "searchable", "scripted", "withdrawn", "gone"]) {
    assert.ok(localToolCallBlockReason(policy, definitions, name, {}), name);
  }
  const none = localToolPolicy([], definitions);
  for (const { name } of definitions) assert.ok(localToolCallBlockReason(none, definitions, name, {}));
});

test("Chat only, streaming get_tools and profile-scoped subagents are not refreshed", async (t) => {
  const resources = { type: "custom", customType: SUBAGENT_META_TYPE, data: {
    version: 1, parentSessionId: "parent", parentSessionPath: "/tmp/parent.jsonl",
    resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: ["read"], loadSkills: false, loadExtensions: false },
  } };
  for (const [args, options] of [
    [{ active: [], entries: [pin([])] }, { chatOnly: true }],
    [{ active: ["read"], entries: [resources] }, {}],
    [{ isStreaming: true }, {}],
  ]) {
    const { wrapper, state } = makeWrapper(args, options);
    t.after(() => wrapper.destroy());
    await wrapper.waitUntilReady();
    await wrapper.send({ type: "get_tools" });
    assert.deepEqual(state.activations, []);
    if (args.entries?.[0] === resources) {
      state.active = ["read", "lookup"];
      wrapper.setActiveToolSelection(BUILD);
      assert.deepEqual(state.active, [...BUILD, "lookup"]);
    }
  }
});

test("legacy subsets retain only active, registered nonhidden extras, never inactive tools", async (t) => {
  const { wrapper, state } = makeWrapper({ active: ["read", "lookup", "searchable", "withdrawn", "gone"] });
  t.after(() => wrapper.destroy());
  await wrapper.send({ type: "set_tools", toolNames: ["read", "withdrawn", "gone"] });
  assert.deepEqual(state.active, ["read", "lookup", "searchable"]);
  assert.ok(!state.active.includes("codemode"));
  assert.ok(!state.active.includes("scripted"));
});

test("legacy reload keeps extensions activated at restart, but not ones switched off", async (t) => {
  const { wrapper, state } = makeWrapper({ entries: [pin(["read"])], active: ["read", "lookup", "searchable"],
    reload: async () => { state.active = ["read", "write", "codemode", "scripted"]; },
  });
  t.after(() => wrapper.destroy());
  await wrapper.send({ type: "reload" });
  assert.deepEqual(state.active, ["read", "codemode", "scripted"]);
  await wrapper.send({ type: "set_tools", toolNames: ["read", "grep"] });
  assert.deepEqual(state.active, ["read", "grep", "codemode", "scripted"]);
});

test("extension navigation forwards options and preserves cancellation and scoped exclusions", async (t) => {
  const resources = { type: "custom", customType: SUBAGENT_META_TYPE, data: {
    version: 1, parentSessionId: "parent", parentSessionPath: "/tmp/parent.jsonl",
    resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: ["read"], loadSkills: false, loadExtensions: false },
  } };
  for (const [entries, options, cancelled] of [
    [[pin(PLAN)], {}, false], [[pin(PLAN)], {}, true],
    [[pin([])], { chatOnly: true }, false], [[resources], {}, false],
  ]) {
    const { wrapper, state } = makeWrapper({ entries, navigateTree: async (target, opts) => {
      assert.equal(target, "older");
      assert.deepEqual(opts, { summarize: true });
      state.active = ["read", "lookup"];
      return { cancelled };
    } }, options);
    t.after(() => wrapper.destroy());
    assert.deepEqual(await wrapper.createExtensionCommandContextActions().navigateTree("older", { summarize: true }), { cancelled });
    const excluded = cancelled || options.chatOnly || entries[0] === resources;
    assert.deepEqual(state.active, excluded ? ["read", "lookup"] : [...PLAN, "subagent", "webfetch"]);
    if (excluded) assert.deepEqual(state.activations, []);
  }
});

test("legacy navigation keeps session discovery tools but not arbitrary extras absent on the branch", async (t) => {
  const sessionTools = ["Agent", "get_subagent_result", "steer_subagent"].map((name) => ({ name, description: name, exposure: "model-only" }));
  const { wrapper, state } = makeWrapper({
    tools: [...definitions, ...sessionTools], entries: [pin(["read"])],
    active: ["read", "lookup", "searchable", "codemode", ...sessionTools.map((tool) => tool.name)],
    navigateTree: async () => {
      state.active = ["read", "bash", "scripted"];
      return { cancelled: false };
    },
  });
  t.after(() => wrapper.destroy());
  await wrapper.send({ type: "navigate_tree", targetId: "older" });
  assert.deepEqual(state.active, ["read", "scripted", "codemode", ...sessionTools.map((tool) => tool.name)]);
});

test("get_tools reports mixed exposures and falls back to definitions only for undeclared tools", async (t) => {
  const { wrapper } = makeWrapper({ entries: [pin(["read"])], active: ["read", "codemode"], agent: { state: { tools: [
    { name: "read", description: "read with a codemode declaration" },
    { name: "codemode", description: "rewritten scripts catalog" },
  ] } } });
  t.after(() => wrapper.destroy());
  const tools = await wrapper.send({ type: "get_tools" });
  const reported = (name) => tools.find((tool) => tool.name === name);
  assert.equal(reported("read").description, "read with a codemode declaration");
  assert.equal(reported("codemode").description, "rewritten scripts catalog");
  assert.equal(reported("codemode").active, true);
  for (const name of ["bash", "scripted", "searchable"]) {
    const definition = definitions.find((tool) => tool.name === name);
    assert.equal(reported(name).description, definition.description);
    assert.equal(reported(name).exposure, definition.exposure);
    assert.equal(reported(name).active, false);
  }
});

test("get_tools preserves declared descriptions and omits withdrawn definitions", async (t) => {
  const { wrapper } = makeWrapper({ entries: [pin(FULL)], agent: { state: { tools: [
    { name: "codemode", description: "Run scripts with rewritten declarations" },
  ] } } });
  t.after(() => wrapper.destroy());
  const tools = await wrapper.send({ type: "get_tools" });
  assert.equal(tools.find((tool) => tool.name === "codemode").description, "Run scripts with rewritten declarations");
  assert.ok(!tools.some((tool) => tool.name === "withdrawn"));
  assert.ok(tools.find((tool) => tool.name === "searchable").active);
  for (const definition of definitions.filter((tool) => tool.exposure !== "hidden")) {
    const reported = tools.find((tool) => tool.name === definition.name);
    assert.equal(reported.exposure, definition.exposure, definition.name);
    assert.equal(reported.active, true, definition.name);
    if (definition.name !== "codemode") assert.equal(reported.description, definition.description, definition.name);
  }
});
