import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, createToolSearchExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const dir = await mkdtemp(join(tmpdir(), "pi-web-local-modes-"));
process.env.PI_CODING_AGENT_DIR = dir;
test.after(() => rm(dir, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, resolveActiveToolNames } = await jiti.import("./rpc-manager.ts");
const { createProjectCommandBashExtension } = await jiti.import("./project-command-env.ts");
const HOST_BASH_PATH = "<inline:pi-web-project-command-environment>";
const { createReadOnlyMcpPolicyExtension } = await jiti.import("./mcp-read-only-policy.ts");
const { appendSessionToolSelection, appendClearedSessionToolSelection } = await jiti.import("./session-tool-selection.ts");
const { getPresetFromTools, getToolNamesForPreset } = await jiti.import("./tool-presets.ts");
const PLAN = ["read", "grep", "find", "ls"];
const BUILD = ["read", "bash", "edit", "write"];
const FULL = [...BUILD, "grep", "find", "ls"];
const sorted = (names) => [...names].sort();
const textOf = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

async function waitForWrapperIdle(wrapper) {
  const deadline = Date.now() + 10_000;
  while (wrapper.isRunning()) {
    assert.ok(Date.now() < deadline, "wrapper prompt did not settle");
    await delay(10);
  }
}

async function createSession(t, selection, settings = {}, extensionFactories = [], { raw = false } = {}) {
  const executed = [];
  const fixtures = { name: "local-mode-fixtures", factory: (pi) => {
    for (const tool of [
      { name: "lookup", description: "untrusted extension" },
      { name: "mcp__fixture__read", description: "read-only MCP still not admitted", annotations: { readOnlyHint: true }, exposure: "deferred", namespace: { name: "mcp__fixture", description: "fixture MCP server" } },
      { name: "mcp__fixture__write", description: "write MCP", exposure: "codemode", namespace: { name: "mcp__fixture", description: "fixture MCP server" } },
      { name: "withdrawn", description: "withdrawn", exposure: "hidden" },
      { name: "subagent", description: "In plan/build, children cannot load extensions or MCP" },
      { name: "webfetch", description: "Read-only webfetch: fixture", annotations: { readOnlyHint: true } },
    ]) pi.registerTool({ ...tool, label: tool.name, parameters: { type: "object", additionalProperties: true },
      async execute(_id, input, _signal, _update, ctx) {
        executed.push(tool.name);
        if (tool.name === "webfetch" && input.nested) {
          const results = await Promise.all(input.nested.map(async (call) => {
            const { name, input: args } = typeof call === "string"
              ? { name: call, input: call === "subagent" ? { agent: "scout" } : {} } : call;
            const outcome = await ctx.executeTool(name, args);
            return `${name}: ${outcome.isError ? textOf(outcome.result) : "ran"}`;
          }));
          return { content: [{ type: "text", text: results.join("\n") }], details: undefined };
        }
        return { content: [{ type: "text", text: "fixture ran" }], details: undefined };
      },
    });
    pi.on("session_start", () => {
      pi.registerTool({ name: "late_lookup", label: "late", description: "registered at session_start", parameters: { type: "object" },
        async execute() { executed.push("late_lookup"); return { content: [{ type: "text", text: "late" }], details: undefined }; },
      });
    });
  } };
  const faux = fauxProvider({ models: [{ id: "faux-local" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, ...settings });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), fixtures, ...extensionFactories, createReadOnlyMcpPolicyExtension(() => settingsManager.getDefaultTools())],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(dir);
  if (selection !== undefined) appendSessionToolSelection(sessionManager, selection);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel("faux-local"), settingsManager, resourceLoader, sessionManager });
  // #1235 must observe SDK registration before the wrapper repairs its loadout.
  if (raw) {
    t.after(() => session.dispose());
    return { session };
  }
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  function responses(calls = []) {
    faux.setResponses([
      () => fauxAssistantMessage(calls.length ? calls : [fauxText("done")], { stopReason: calls.length ? "toolUse" : "stop" }),
      () => fauxAssistantMessage([fauxText("done")]),
    ]);
  }
  return { session, wrapper, executed, responses };
}

function hostBashExtension() {
  return createProjectCommandBashExtension({
    cwd: dir,
    settings: { getShellCommandPrefix: () => undefined, getShellPath: () => undefined },
  });
}

test("sanitized bash is active only when named before wrapper policy applies (#1235)", async (t) => {
  const { session: plain } = await createSession(t, undefined, {}, [hostBashExtension()], { raw: true });
  assert.ok(plain.getActiveToolNames().includes("bash"));
  assert.equal(plain.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.path, HOST_BASH_PATH);

  for (const defaultTools of [["read"], ["codemode"], ["-bash"]]) {
    const { session } = await createSession(t, undefined, { defaultTools }, [hostBashExtension()], { raw: true });
    assert.ok(!session.getActiveToolNames().includes("bash"), defaultTools.join());
    if (defaultTools.includes("codemode")) assert.ok(session.getActiveToolNames().includes("codemode"));
    await session.reload();
    assert.ok(!session.getActiveToolNames().includes("bash"), `reload: ${defaultTools.join()}`);
  }

  const { session } = await createSession(t, undefined, { defaultTools: ["read"] }, [hostBashExtension()], { raw: true });
  session.setActiveToolsByName(resolveActiveToolNames(session, BUILD, session.getActiveToolNames()));
  assert.ok(session.getActiveToolNames().includes("bash"));
  assert.equal(session.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.path, HOST_BASH_PATH);
  session.setActiveToolsByName(resolveActiveToolNames(session, PLAN, session.getActiveToolNames()));
  await session.reload();
  assert.ok(!session.getActiveToolNames().includes("bash"));
});

test("sanitized bash follows local plan/build policy despite defaultTools and command reload", async (t) => {
  const reloadSwitch = { name: "reload-widens-tools", factory: (pi) => {
    pi.on("session_start", (event) => {
      if (event.reason === "reload") pi.setActiveTools([...FULL, "lookup", "codemode"]);
    });
  } };
  const previousRuntime = globalThis.__piWebSharedModelRuntime;
  t.after(() => { globalThis.__piWebSharedModelRuntime = previousRuntime; });
  for (const selection of [undefined, PLAN, BUILD]) {
    const { session, wrapper } = await createSession(t, selection, { defaultTools: ["read"] }, [hostBashExtension(), reloadSwitch]);
    const expected = sorted([...(selection ?? BUILD), "subagent", "webfetch"]);
    assert.deepEqual(sorted(session.getActiveToolNames()), expected);
    globalThis.__piWebSharedModelRuntime = { fixture: true };
    await wrapper.createExtensionCommandContextActions().reload();
    // Do not call get_tools first: it would conceal a missing reload refresh.
    assert.deepEqual(sorted(session.getActiveToolNames()), expected);
    assert.equal(globalThis.__piWebSharedModelRuntime, undefined);
  }
});

test("ready/get_tools/prompt/reload restore build despite defaultTools and late registration", async (t) => {
  const { session, wrapper, responses } = await createSession(t, undefined, { defaultTools: ["+codemode"] });
  const expected = sorted([...BUILD, "subagent", "webfetch"]);
  assert.deepEqual(sorted(session.getActiveToolNames()), expected);
  session.setActiveToolsByName(["lookup", "codemode", ...FULL]);
  assert.deepEqual(sorted((await wrapper.send({ type: "get_tools" })).filter((tool) => tool.active).map((tool) => tool.name)), expected);
  session.setActiveToolsByName(["lookup", ...FULL]);
  responses();
  await wrapper.send({ type: "prompt", message: "restore build" });
  // send() acknowledges preflight, not completion. SDK idle alone can precede
  // the wrapper's completion handler (or even the start of the accepted run).
  await waitForWrapperIdle(wrapper);
  assert.ok(session.messages.some((message) => message.role === "assistant" && textOf(message) === "done"));
  assert.deepEqual(sorted(session.getActiveToolNames()), expected);
  await wrapper.send({ type: "reload" });
  assert.deepEqual(sorted(session.getActiveToolNames()), expected);
  appendSessionToolSelection(session.sessionManager, FULL);
  await wrapper.waitUntilReady();
  assert.ok(session.getActiveToolNames().includes("late_lookup"));
  appendClearedSessionToolSelection(session.sessionManager);
  await wrapper.waitUntilReady();
  assert.deepEqual(sorted(session.getActiveToolNames()), expected);
});

test("before_agent_start covers direct prompts and custom-triggered runs (pi 1.2 union)", async (t) => {
  const { session, responses, executed } = await createSession(t, PLAN);
  responses([fauxToolCall("lookup", {}), fauxToolCall("webfetch", {})]);
  session.setActiveToolsByName([...FULL, "lookup"]);
  await session.prompt("direct SDK prompt");
  assert.deepEqual(sorted(session.getActiveToolNames()), sorted([...PLAN, "subagent", "webfetch"]));
  assert.deepEqual(executed, ["webfetch"]);
  assert.match(session.agent.state.systemPrompt, /Current tool mode: plan; subagent roles: scout \/ planner/);

  session.setActiveToolsByName([...FULL, "lookup"]);
  responses([fauxToolCall("lookup", {})]);
  await session.sendCustomMessage({ customType: "fixture-trigger", content: "continue", display: false }, { triggerTurn: true });
  await session.waitForIdle();
  assert.deepEqual(sorted(session.getActiveToolNames()), sorted([...PLAN, "subagent", "webfetch"]));
  assert.deepEqual(executed, ["webfetch"]);
});

test("plan/build guard nested deferred/codemode calls, even an annotated read-only MCP tool", async (t) => {
  for (const selection of [PLAN, BUILD]) {
    const { session, responses, executed } = await createSession(t, selection);
    responses([fauxToolCall("webfetch", { nested: ["mcp__fixture__read", "mcp__fixture__write", "lookup", "subagent"] })]);
    await session.prompt("nested calls");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "webfetch");
    assert.match(textOf(result), /mcp__fixture__read: .*disabled/);
    assert.match(textOf(result), /mcp__fixture__write: .*disabled/);
    // An inactive direct tool may be rejected by pi before the policy, but never runs.
    assert.ok(!executed.includes("lookup"));
    assert.deepEqual(executed, ["webfetch", "subagent"]);
  }
});

test("full activates all nonhidden exposures and admits extension/MCP fixture calls", async (t) => {
  const { session, responses, executed, wrapper } = await createSession(t, FULL);
  const names = session.getAllTools().filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
  assert.deepEqual(sorted(session.getActiveToolNames()), sorted(names));
  responses([fauxToolCall("lookup", {}), fauxToolCall("mcp__fixture__read", {}), fauxToolCall("mcp__fixture__write", {}), fauxToolCall("late_lookup", {})]);
  await session.prompt("full mode");
  assert.deepEqual(sorted(executed), ["late_lookup", "lookup", "mcp__fixture__read", "mcp__fixture__write"]);
  const tools = await wrapper.send({ type: "get_tools" });
  assert.ok(!tools.some((tool) => tool.name === "withdrawn"));
  const codemode = tools.find((tool) => tool.name === "codemode");
  assert.equal(codemode.description, session.agent.state.tools.find((tool) => tool.name === "codemode").description);
  assert.notEqual(codemode.description, session.getToolDefinition("codemode").description);
  assert.match(codemode.description, /## mcp__fixture\nfixture MCP server/);
  assert.match(codemode.description, /write MCP/);
});

test("full live tools refresh stays full and selecting build restricts the backend", async (t) => {
  const { session, wrapper } = await createSession(t, FULL);
  const tools = await wrapper.send({ type: "get_tools" });
  assert.ok(tools.find((tool) => tool.name === "bash").active);
  assert.ok(tools.find((tool) => tool.name === "powershell").active);
  assert.equal(getPresetFromTools(tools), "full");
  const buildTools = getToolNamesForPreset("default");
  appendSessionToolSelection(session.sessionManager, buildTools);
  wrapper.setActiveToolSelection(buildTools);
  assert.equal(getPresetFromTools(await wrapper.send({ type: "get_tools" })), "default");
  assert.deepEqual(sorted(session.getActiveToolNames()), sorted([...BUILD, "subagent", "webfetch"]));
  const blocked = await session.extensionRunner.emitToolCall({
    type: "tool_call", toolCallId: "full-to-build", toolName: "mcp__fixture__read", input: {},
  });
  assert.equal(blocked.block, true);
});

test("legacy subsets keep codemode only when defaultTools activated it, not merely on registration", async (t) => {
  for (const activateCodemode of [false, true]) {
    const { session } = await createSession(t, ["read"], activateCodemode ? { defaultTools: ["+codemode"] } : {});
    assert.deepEqual(sorted(session.getActiveToolNames()), sorted([
      "read", "lookup", "late_lookup", "subagent", "webfetch", ...(activateCodemode ? ["codemode"] : []),
    ]));
  }
});

test("get_tools marks declarations hidden by codemode only mode, but not automatic mode", async (t) => {
  for (const only of [true, false]) {
    const { session, wrapper } = await createSession(t, FULL, only ? { codemode: { mode: "only" } } : {});
    const tools = await wrapper.send({ type: "get_tools" });
    assert.ok(tools.find((tool) => tool.name === "codemode").active);
    const directNames = sorted(session.getAllTools().filter((tool) =>
      tool.exposure === undefined || tool.exposure === "direct",
    ).map((tool) => tool.name));
    const hidden = tools.filter((tool) => tool.declarationHidden);
    assert.deepEqual(sorted(hidden.map((tool) => tool.name)), only ? directNames : []);
    // Hidden declarations remain in the active loadout: scripts can still call
    // them, and get_tools must distinguish that from an inactive tool.
    assert.ok(hidden.every((tool) => tool.active));
    assert.deepEqual(sorted(tools.filter((tool) => tool.active).map((tool) => tool.name)), sorted(session.getActiveToolNames()));
  }
});

test("real tree navigation restores the latest plan pin over an older build loadout", async (t) => {
  const { session, wrapper, responses } = await createSession(t);
  responses();
  await session.prompt("first branch in build");
  const firstLeafId = session.sessionManager.getLeafId();
  appendSessionToolSelection(session.sessionManager, PLAN);
  wrapper.setActiveToolSelection(PLAN);
  responses();
  await session.prompt("second branch in plan");
  const secondLeafId = session.sessionManager.getLeafId();
  const expected = sorted([...PLAN, "subagent", "webfetch"]);
  await session.navigateTree(firstLeafId, {});
  assert.deepEqual(sorted(session.getActiveToolNames()), sorted([...BUILD, "subagent", "webfetch"]));
  await session.navigateTree(secondLeafId, {});
  assert.deepEqual(sorted(session.getActiveToolNames()), expected);
  assert.deepEqual(await wrapper.send({ type: "navigate_tree", targetId: firstLeafId }), { cancelled: false });
  assert.equal(session.sessionManager.getLeafId(), firstLeafId);
  assert.deepEqual(sorted(session.getActiveToolNames()), expected);
});

test("reload preserves legacy coding subsets and extensions' changed discovery loadout", async (t) => {
  const reloadSwitch = { name: "reload-switch", factory: (pi) => {
    pi.on("session_start", (event) => {
      if (event.reason === "reload") pi.setActiveTools([
        ...pi.getActiveTools().filter((name) => name !== "tool_search"), "codemode",
      ]);
    });
  } };
  const { session, wrapper } = await createSession(t, ["read"], {}, [reloadSwitch]);
  session.setActiveToolsByName([...session.getActiveToolNames(), "tool_search"]);
  const before = sorted(session.getActiveToolNames());
  assert.ok(before.includes("tool_search"));
  assert.deepEqual(await wrapper.send({ type: "reload" }), { success: true });
  assert.deepEqual(sorted(session.getActiveToolNames()), sorted([
    ...before.filter((name) => name !== "tool_search"), "codemode",
  ]));
});

test("plan/build validates flat single/parallel/chain roles and root scopes, including ctx.executeTool calls", async (t) => {
  const buildRoles = ["scout", "planner", "worker", "reviewer"];
  const task = (agent) => ({ agent, task: "fixture task" });
  for (const selection of [PLAN, BUILD]) {
    const { session, responses, executed } = await createSession(t, selection);
    const deniedRoles = selection === PLAN ? ["worker", "reviewer", "unknown"] : ["unknown"];
    const args = [
      ...deniedRoles.flatMap((agent) => [
        task(agent),
        { tasks: [task("scout"), task(agent)] },
        { chain: [task("scout"), task(agent)] },
      ]),
      ...(selection === PLAN ? [{ tasks: buildRoles.map(task) }, { chain: buildRoles.map(task) }] : []),
      ...["project", "both", "unknown"].flatMap((agentScope) => [
        { ...task("scout"), agentScope },
        { tasks: [task("scout")], agentScope },
        { chain: [task("scout")], agentScope },
      ]),
    ];
    responses(args.map((input) => fauxToolCall("subagent", input)));
    await session.prompt("blocked flat child batches");
    assert.deepEqual(executed, []);
    const results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, args.length);
    assert.ok(results.every((result) => result.isError));
    const roles = selection === PLAN ? ["scout", "planner"] : buildRoles;
    const allowedRequests = [
      ...roles.map((agent) => ({ ...task(agent), agentScope: "user" })),
      { tasks: roles.map(task) },
      { chain: roles.map(task), agentScope: "user" },
    ];
    responses(allowedRequests.map((input) => fauxToolCall("subagent", input)));
    await session.prompt("allowed flat children");
    assert.deepEqual(executed, Array(allowedRequests.length).fill("subagent"));
    assert.match(session.agent.state.systemPrompt, selection === PLAN
      ? /plan; subagent roles: scout \/ planner \(read-only\)/
      : /build; subagent roles: scout \/ planner \(read-only\), worker \/ reviewer/);

    executed.length = 0;
    responses([fauxToolCall("webfetch", { nested: [
      ...args.map((input) => ({ name: "subagent", input })),
      ...allowedRequests.map((input) => ({ name: "subagent", input })),
    ] })]);
    await session.prompt("ctx.executeTool enforces the same flat child policy");
    assert.deepEqual(executed, ["webfetch", ...Array(allowedRequests.length).fill("subagent")]);
    const nestedResult = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "webfetch");
    const nestedLines = textOf(nestedResult).split("\n");
    assert.equal(nestedLines.length, args.length + allowedRequests.length);
    assert.ok(nestedLines.slice(0, args.length).every((line) => /only permits subagent roles|must use user-level roles/.test(line)));
    assert.deepEqual(nestedLines.slice(args.length), Array(allowedRequests.length).fill("subagent: ran"));
  }
});
