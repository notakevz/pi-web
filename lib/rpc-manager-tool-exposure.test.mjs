import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, resolveActiveToolNames } = await jiti.import("./rpc-manager.ts");
const { TOOL_SELECTION_TYPE } = await jiti.import("./session-tool-selection.ts");
const { SUBAGENT_META_TYPE } = await jiti.import("./subagents.ts");
const { localToolPolicy, localToolCallBlockReason } = await jiti.import("./local-tool-modes.ts");
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
    sessionManager: { getCwd: () => "", getEntries: () => entries },
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
