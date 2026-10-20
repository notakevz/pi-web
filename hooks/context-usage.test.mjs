import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const { agentStatusUrl } = await createJiti(import.meta.url, { interopDefault: true }).import("../lib/agent-client.ts");

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
function callback(name, transform = (text) => text) {
  const node = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(node, `missing ${name}`);
  return new Script(ts.transpileModule(`(${transform(node.initializer.arguments[0].getText(source))})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
function setup({ transform } = {}) {
  const writes = [], prompts = [], settlements = [], models = [];
  const requests = [];
  const context = createContext({
    sessionHookMountedRef: { current: true }, sessionMountGenerationRef: { current: 1 }, sessionIdRef: { current: "a" },
    promptRunIdRef: { current: 1 }, contextUsageRequestIdRef: { current: 0 }, contextUsageAppliedIdRef: { current: 0 },
    sessionReadIdRef: { current: 0 }, sessionReadAppliedIdRef: { current: 0 }, sessionSettingsReadFloorRef: { current: 0 },
    agentRunningRef: { current: true }, sdkAgentActiveRef: { current: true }, rpcPromptPendingRef: { current: true },
    setContextUsage: (value) => writes.push(value), agentStatusUrl,
    fetch: (url) => { const request = Promise.withResolvers(); requests.push({ ...request, url }); return request.promise; },
    syncLiveModel: (state) => models.push(state), setIsCompacting() {}, setAutoCompactionEnabled() {}, setQueuedMessages() {},
    normalizeQueuedMessages: (value) => value, finishPromptWithoutStream: (...args) => settlements.push(args),
    setExtensionStatuses() {}, setExtensionWidgets() {}, setSystemPrompt: (prompt) => prompts.push(prompt),
  });
  context.applyContextUsage = callback("applyContextUsage").runInContext(context);
  context.refreshContextUsage = callback("refreshContextUsage").runInContext(context);
  context.reconcileAgentState = callback("reconcileAgentState", transform).runInContext(context);
  const reply = (index, usage, busy = true) => requests[index].resolve(Response.json({ running: busy, state: { contextUsage: usage, isStreaming: busy, isPromptRunning: busy } }));
  return { context, writes, requests, reply, prompts, settlements, models };
}
const usage = (tokens) => ({ percent: tokens / 100, contextWindow: 10_000, tokens });

test("a busy reconciliation refreshes context usage without settling the run", async () => {
  const state = setup();
  const pending = state.context.reconcileAgentState("a");
  state.reply(0, usage(100));
  await pending;
  assert.deepEqual(state.writes, [usage(100)]);
  assert.equal(state.context.agentRunningRef.current, true);
  assert.deepEqual(state.settlements, [], "busy polls must not silently take a failing finish path");
  // Status reads leave out the system prompt, nearly all of the state (#1302).
  assert.equal(state.requests[0].url, "/api/agent/a?systemPrompt=0");
});

test("a newer assistant usage read wins over a delayed poll", async () => {
  const state = setup();
  const poll = state.context.reconcileAgentState("a");
  const refresh = state.context.refreshContextUsage("a");
  state.reply(1, usage(200)); await refresh;
  state.reply(0, usage(100)); await poll;
  assert.deepEqual(state.writes, [usage(200)]);
});

test("a failed newer read does not discard an older poll's usage", async () => {
  const state = setup();
  const poll = state.context.reconcileAgentState("a");
  const refresh = state.context.refreshContextUsage("a");
  state.requests[1].resolve(new Response("Unavailable", { status: 503 })); await refresh;
  state.reply(0, usage(100)); await poll;
  assert.deepEqual(state.writes, [usage(100)]);
});

test("usage replies from an old run, another session or an unmounted hook are ignored", async () => {
  for (const invalidate of [
    (ctx) => { ctx.promptRunIdRef.current++; },
    (ctx) => { ctx.sessionIdRef.current = "b"; },
    (ctx) => { ctx.sessionHookMountedRef.current = false; },
    (ctx) => { ctx.contextUsageAppliedIdRef.current = ctx.contextUsageRequestIdRef.current; },
  ]) {
    const state = setup();
    const pending = state.context.refreshContextUsage("a");
    invalidate(state.context); state.reply(0, usage(100)); await pending;
    assert.deepEqual(state.writes, []);
  }
});

test("an acknowledged settings write fences a delayed poll's model/effort without dropping its valid run usage", async () => {
  const state = setup();
  const pending = state.context.reconcileAgentState("a");
  state.context.sessionSettingsReadFloorRef.current = state.context.sessionReadIdRef.current;
  state.reply(0, usage(100)); await pending;
  assert.deepEqual(state.models, []);
  assert.deepEqual(state.writes, [usage(100)]);
  assert.deepEqual(state.settlements, []);
});

test("failed reads preserve usage and a subsequent read can recover", async () => {
  const state = setup();
  const failed = state.context.refreshContextUsage("a");
  state.requests[0].resolve(new Response("Unavailable", { status: 503 })); await failed;
  const broken = state.context.refreshContextUsage("a");
  state.requests[1].reject(new TypeError("offline")); await broken;
  assert.deepEqual(state.writes, []);
  const recovered = state.context.refreshContextUsage("a");
  state.reply(2, null); await recovered;
  assert.deepEqual(state.writes, [null]);
});

async function finishingRead(options) {
  const state = setup(options);
  const pending = state.context.reconcileAgentState("a");
  state.reply(0, usage(100), false);
  await pending;
  assert.deepEqual(state.settlements.map((args) => Array.from(args)), [["a", 1]]);
  assert.equal(state.requests[1]?.url, "/api/agent/a", "one full-prompt read follows the prompt-free idle status");
  return state;
}

const drain = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("finish reads the full prompt once without blocking settlement", async () => {
  const state = await finishingRead();
  state.requests[1].resolve(Response.json({ state: { systemPrompt: "finished prompt" } }));
  await drain();
  assert.deepEqual(state.prompts, ["finished prompt"]);
});

test("a delayed finish prompt cannot overwrite the same session's next run or a departed mount", async () => {
  for (const invalidate of [
    (ctx) => { ctx.promptRunIdRef.current++; },
    (ctx) => { ctx.sessionIdRef.current = "b"; },
    (ctx) => { ctx.sessionHookMountedRef.current = false; },
    (ctx) => { ctx.sessionMountGenerationRef.current++; },
  ]) {
    const state = await finishingRead();
    invalidate(state.context);
    state.context.setSystemPrompt("new run's prompt");
    state.requests[1].resolve(Response.json({ state: { systemPrompt: "stale finish prompt" } }));
    await drain();
    assert.deepEqual(state.prompts, ["new run's prompt"]);
  }
});

test("negative control: the upstream finish guard accepts an old run's delayed prompt", async () => {
  const state = await finishingRead({ transform: (text) => {
    const guard = "sessionMountGenerationRef.current !== generation\n              || sessionIdRef.current !== sid || promptRunIdRef.current !== runId";
    assert.ok(text.includes(guard), "mutate only the independent full-prompt promise guard");
    return text.replace(guard, "sessionIdRef.current !== sid");
  } });
  state.context.promptRunIdRef.current++;
  state.context.setSystemPrompt("new run's prompt");
  state.requests[1].resolve(Response.json({ state: { systemPrompt: "stale finish prompt" } }));
  await drain();
  assert.deepEqual(state.prompts, ["new run's prompt", "stale finish prompt"]);
});

test("a delayed status from an old run or mount must not schedule a full-prompt read or finish", async () => {
  for (const invalidate of [
    (ctx) => { ctx.promptRunIdRef.current++; },
    (ctx) => { ctx.sessionHookMountedRef.current = false; },
    (ctx) => { ctx.sessionMountGenerationRef.current++; },
  ]) {
    const state = setup();
    const pending = state.context.reconcileAgentState("a");
    invalidate(state.context);
    state.reply(0, usage(100), false); await pending;
    assert.equal(state.requests.length, 1);
    assert.deepEqual(state.settlements, []);
    assert.deepEqual(state.writes, []);
  }
});

function agentEndRead({ transform = (text) => text } = {}) {
  const state = setup();
  const history = [], statuses = [], widgets = [], queues = [];
  Object.assign(state.context, {
    rpcPromptPendingRef: { current: false },
    setAgentPhase() {}, setRetryInfo() {}, dispatch() {}, onAgentEnd() {}, scheduleEventStreamClose() {},
    setExtensionStatuses: (value) => statuses.push(value), setExtensionWidgets: (value) => widgets.push(value),
    setQueuedMessages: (value) => queues.push(value),
    settleUiStage: () => { state.context.agentRunningRef.current = false; return true; },
    loadSession: () => {
      const id = ++state.context.sessionReadIdRef.current;
      const gate = Promise.withResolvers();
      history.push({ ...gate, id });
      return gate.promise.then(() => { state.context.sessionReadAppliedIdRef.current = id; });
    },
  });
  const handle = callback("handleAgentEvent", transform).runInContext(state.context);
  handle({ type: "agent_end" }); // history H + full-state F
  return { ...state, history, statuses, widgets, queues, handle };
}

async function newerSettledHistory(state) {
  state.history[0].resolve(); await drain();
  state.handle({ type: "agent_settled" }); // same logical run, newer history H2
  assert.equal(state.history.length, 2);
  state.history[1].resolve(); await drain();
  assert.ok(state.context.sessionReadAppliedIdRef.current > state.history[0].id + 1, "H2 completed after F started");
}

const fullState = () => ({ state: {
  model: { provider: "local", id: "model" }, thinkingLevel: "high", systemPrompt: "finished full prompt",
  extensionStatuses: [{ key: "status", text: "finished" }], extensionWidgets: [{ key: "widget", lines: ["finished"] }],
  queuedMessages: { steering: ["next"], followUp: [] }, contextUsage: usage(100),
} });

test("agent_end without a newer settings/history result still applies model, prompt and usage", async () => {
  const state = agentEndRead();
  state.history[0].resolve(); await drain();
  state.requests[0].resolve(Response.json(fullState())); await drain();
  assert.deepEqual(state.models, [fullState().state]);
  assert.deepEqual(state.prompts, ["finished full prompt"]);
  assert.deepEqual(state.writes, [usage(100)]);
});

for (const confirmedWrite of [false, true]) {
  test(`same-run agent_end keeps full prompt/extensions after newer settled history${confirmedWrite ? " and confirmed effort" : ""}`, async () => {
    const state = agentEndRead();
    assert.equal(state.requests[0].url, "/api/agent/a");
    await newerSettledHistory(state);
    // An acknowledged newer effort fences settings only, not the full prompt.
    if (confirmedWrite) state.context.sessionSettingsReadFloorRef.current = state.context.sessionReadIdRef.current;
    const refresh = state.context.refreshContextUsage("a");
    state.reply(1, usage(200)); await refresh;
    state.requests[0].resolve(Response.json(fullState())); await drain();
    assert.deepEqual(state.prompts, ["finished full prompt"], "history H2 does not contain a replacement prompt");
    assert.deepEqual(state.statuses, [fullState().state.extensionStatuses]);
    assert.deepEqual(state.widgets, [fullState().state.extensionWidgets]);
    assert.deepEqual(state.queues, [fullState().state.queuedMessages]);
    assert.deepEqual(state.models, [], "F's high must not roll back the newer canonical/explicit effort");
    assert.deepEqual(state.writes, [usage(200)], "usage remains independently ordered");
  });
}

test("agent_end full-state replies still reject old runs, sessions and mounts entirely", async () => {
  for (const invalidate of [
    (ctx) => { ctx.promptRunIdRef.current++; },
    (ctx) => { ctx.sessionIdRef.current = "b"; },
    (ctx) => { ctx.sessionHookMountedRef.current = false; },
    (ctx) => { ctx.sessionMountGenerationRef.current++; },
  ]) {
    const state = agentEndRead();
    await newerSettledHistory(state);
    invalidate(state.context);
    state.requests[0].resolve(Response.json(fullState())); await drain();
    for (const writes of [state.prompts, state.models, state.statuses, state.widgets, state.queues, state.writes]) assert.deepEqual(writes, []);
  }
});

test("negative control: removing agent_end's run/mount guard accepts a departed full prompt", async () => {
  for (const invalidate of [
    (ctx) => { ctx.promptRunIdRef.current++; },
    (ctx) => { ctx.sessionMountGenerationRef.current++; },
  ]) {
    const state = agentEndRead({ transform: (text) => {
      const guard = "sessionMountGenerationRef.current !== generation\n                || sessionIdRef.current !== sid || promptRunIdRef.current !== runId";
      assert.ok(text.includes(guard));
      return text.replace(guard, "sessionIdRef.current !== sid");
    } });
    invalidate(state.context);
    state.requests[0].resolve(Response.json(fullState())); await drain();
    assert.deepEqual(state.prompts, ["finished full prompt"], "negative control accepts the stale full reply");
  }
});

test("negative control: whole-response settings ordering loses the same-run finished prompt", async () => {
  const state = agentEndRead({ transform: (text) => {
    const guard = "if (settingsReadId > sessionSettingsReadFloorRef.current\n                && settingsReadId >= sessionReadAppliedIdRef.current) syncLiveModel(d.state);";
    assert.ok(text.includes(guard));
    return text.replace(guard, "if (settingsReadId <= sessionSettingsReadFloorRef.current || settingsReadId < sessionReadAppliedIdRef.current) return; syncLiveModel(d.state);");
  } });
  await newerSettledHistory(state);
  state.requests[0].resolve(Response.json(fullState())); await drain();
  assert.deepEqual(state.prompts, [], "negative control reproduces the stale System panel");
  assert.deepEqual(state.statuses, []);
});

test("only completed assistant messages trigger an immediate usage read", () => {
  const messageEnd = nodes.find((node) => ts.isCaseClause(node) && node.expression.getText(source) === '"message_end"');
  const script = new Script(ts.transpileModule(`(() => { switch(event.type) { ${messageEnd.getText(source)} } })()`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  for (const role of ["assistant", "toolResult", "user", "system"]) {
    const reads = [];
    script.runInNewContext({
      event: { type: "message_end", message: { role, content: [] } },
      agentRunningRef: { current: true }, sessionIdRef: { current: "a" }, optimisticUserMessageKeyRef: { current: null },
      isSystemMessageEvent: (event) => event.message.role === "system",
      normalizeToolCalls: (message) => message, userMessageKey: () => "user", setMessages() {}, dispatch() {}, setAgentPhase() {},
      refreshContextUsage: (sid) => reads.push(sid),
    });
    assert.deepEqual(reads, role === "assistant" ? ["a"] : []);
  }
});

test("each event stream connection reads usage, since connecting resumes an idle-reaped session", () => {
  const connected = nodes.find((node) => ts.isCaseClause(node) && node.expression.getText(source) === '"connected"');
  const script = new Script(ts.transpileModule(`(() => { switch(event.type) { ${connected.getText(source)} } })()`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  for (const [sid, isStreaming] of [["a", false], ["a", true], [null, false]]) {
    const reads = [];
    script.runInNewContext({
      event: { type: "connected", sessionId: sid ?? "pending", isStreaming },
      sessionIdRef: { current: sid }, sdkAgentActiveRef: { current: false }, agentRunningRef: { current: false },
      dispatch() {}, cancelEventStreamGrace() {}, setAgentRunning() {}, setAgentPhase() {},
      refreshContextUsage: (id) => reads.push(id),
    });
    assert.deepEqual(reads, sid ? [sid] : []);
  }
});
