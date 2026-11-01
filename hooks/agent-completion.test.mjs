import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const shim = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shim } });
const { renderHook } = await import(pathToFileURL(shim).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "hidden" });
globalThis.window ??= new EventTarget();
const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };

async function setup(t) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sources = [], ended = [], attention = [], statuses = [], histories = [];
  const statusQueue = [], historyQueue = [];
  let running = false;
  let disconnected = false;
  let snapshot;
  const queuedRead = (queue, requests, body) => {
    requests.push(body);
    const gate = queue.shift();
    if (!gate) return json(body);
    gate.requested = true;
    return gate.promise.then(() => json(gate.body ?? body));
  };
  const defer = (queue, body) => {
    const gate = { ...Promise.withResolvers(), body, requested: false };
    queue.push(gate);
    return gate;
  };
  globalThis.EventSource = class {
    readyState = 0;
    constructor() { sources.push(this); }
    close() { this.readyState = 2; }
    emit(event) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(event) }); }
  };
  globalThis.fetch = async (url, init = {}) => {
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url.startsWith("/api/sessions/notify?")) return queuedRead(historyQueue, histories, { sessionId: "notify", tree: [], leafId: null, context: { messages: [], entryIds: [] } });
    if (url === "/api/sessions/notify/state" || (url.startsWith("/api/agent/notify") && !init.body)) {
      return queuedRead(statusQueue, statuses, snapshot ?? { running, state: { isStreaming: running, isPromptRunning: running } });
    }
    return json({ success: true, data: null });
  };
  const hook = renderHook(useAgentSession, {
    session: { id: "notify", cwd: "/project", name: "Parent" },
    onAgentEnd: (end) => ended.push(end), onAttentionNeeded: (request) => attention.push(request),
  });
  t.after(() => { hook.unmount(); mock.timers.reset(); });
  await settle(); hook.flush();
  const emit = async (...events) => {
    for (const event of events) {
      if (event.type === "agent_start") running = true;
      if (event.type === "agent_settled") running = false;
      if (!disconnected) sources.filter((s) => s.readyState !== 2).at(-1).emit(event);
    }
    await settle(); hook.flush();
  };
  await emit({ type: "connected", sessionId: "notify", isStreaming: false });
  const tick = async (ms) => { mock.timers.tick(ms); await settle(); hook.flush(); };
  return {
    hook, emit, ended, attention, tick, statuses, histories,
    disconnect: () => { disconnected = true; for (const source of sources) source.close(); },
    setSnapshot: (value) => { snapshot = value; },
    deferStatus: (body) => defer(statusQueue, body),
    deferHistory: () => defer(historyQueue),
    reconcile: async () => { hook.flush(); window.dispatchEvent(new Event("online")); await settle(); hook.flush(); },
    drain: async () => { await settle(); hook.flush(); },
  };
}

const activeSnapshot = { running: true, state: { isStreaming: true, isPromptRunning: true } };
const idleSnapshot = { running: false, state: { isStreaming: false, isPromptRunning: false } };

test("an injected SDK start during an idle history read cannot be cleared or announced by that finish", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("/ask delegate");
  const history = env.deferHistory();
  await env.tick(800);
  assert.equal(history.requested, true);
  await env.emit({ type: "agent_start" });
  history.resolve(); await env.drain();
  assert.equal(env.hook.result.agentRunning, true);
  assert.deepEqual(env.ended, []);
  await env.emit({ type: "prompt_done" });
  assert.equal(env.hook.result.agentRunning, true, "the newer SDK run still owns the UI");
  assert.deepEqual(env.ended, []);
  await env.emit({ type: "agent_settled", aborted: false });
  assert.deepEqual(env.ended, [{ aborted: false }]);
  await env.tick(600);
  assert.equal(env.ended.length, 1);
});

for (const recovery of ["settle poll", "reconcile"]) {
  for (const snapshot of [idleSnapshot, activeSnapshot]) {
    test(`${recovery} drops a deferred ${snapshot.running ? "busy" : "idle"} status across an injected SDK lifecycle`, async (t) => {
      const env = await setup(t);
      await env.hook.result.handleSend("/ask delegate");
      const status = env.deferStatus(snapshot);
      if (recovery === "settle poll") await env.tick(800);
      else await env.reconcile();
      assert.equal(status.requested, true);
      const historyCount = env.histories.length;
      await env.emit({ type: "agent_start" });
      status.resolve(); await env.drain();
      assert.equal(env.histories.length, historyCount, "stale idle status must not start a history read");
      assert.equal(env.hook.result.agentRunning, true);
      assert.deepEqual(env.ended, []);
      await env.emit({ type: "prompt_done" }, { type: "agent_settled", aborted: false });
      assert.deepEqual(env.ended, [{ aborted: false }]);
      await env.tick(600);
      assert.equal(env.ended.length, 1);
    });
  }
}

test("a newly settled SDK generation during a history read retains its outcome until a fresh idle check", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("/ask delegate");
  const history = env.deferHistory();
  await env.tick(800);
  assert.equal(history.requested, true);
  await env.emit({ type: "agent_start" }, { type: "agent_settled", aborted: true });
  history.resolve(); await env.drain();
  assert.deepEqual(env.ended, []);
  await env.tick(600);
  assert.deepEqual(env.ended, [{ aborted: true }]);
  await env.emit({ type: "prompt_done" });
  assert.equal(env.ended.length, 1);
});

test("disconnected SSE: a busy settlement snapshot arms a fast SDK run before the 15-second reconcile", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("/ask delegate");
  env.disconnect();
  env.setSnapshot(activeSnapshot);
  await env.tick(800);
  assert.deepEqual(env.ended, []);
  env.setSnapshot(idleSnapshot);
  await env.tick(600);
  assert.equal(env.hook.result.agentRunning, false);
  assert.deepEqual(env.ended, [{ aborted: false }]);
  await env.tick(15_000);
  assert.equal(env.ended.length, 1);
});

for (const outcome of [{ aborted: true }, { aborted: false, subagentsActive: true }]) {
  for (const recovery of ["settle poll", "reconcile"]) {
    test(`${recovery}: a new snapshot-only run drops old ${outcome.aborted ? "abort" : "subagentsActive"} suppression`, async (t) => {
      const env = await setup(t);
      await env.hook.result.handleSend("/ask first");
      await env.emit({ type: "agent_start" }, { type: "agent_settled", ...outcome }, { type: "prompt_done", ...outcome });
      assert.deepEqual(env.ended, [outcome]);
      // No lifecycle events reach the page for the next, successful run.
      await env.hook.result.handleSend("/ask next");
      env.disconnect();
      env.setSnapshot(activeSnapshot);
      if (recovery === "settle poll") await env.tick(800);
      else await env.reconcile();
      env.setSnapshot(idleSnapshot);
      if (recovery === "settle poll") await env.tick(600);
      else await env.reconcile();
      assert.deepEqual(env.ended, [outcome, { aborted: false }]);
    });
  }

  test(`a same-run pending-command snapshot preserves its settled ${outcome.aborted ? "abort" : "subagentsActive"} outcome`, async (t) => {
    const env = await setup(t);
    await env.hook.result.handleSend("/ask delegate");
    await env.emit({ type: "agent_start" }, { type: "agent_settled", ...outcome });
    env.disconnect();
    env.setSnapshot({ running: true, state: { isStreaming: false, isPromptRunning: true } });
    await env.tick(800);
    await env.reconcile();
    assert.deepEqual(env.ended, []);
    env.setSnapshot(idleSnapshot);
    await env.tick(600);
    assert.deepEqual(env.ended, [outcome]);
  });
}

test("handled command prompt_done ends the UI stage without announcing a completed run", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("/status");
  await env.emit({ type: "prompt_done" });
  assert.equal(env.hook.result.agentRunning, false);
  assert.deepEqual(env.ended, []);
});

test("a handled command accepted before its injected run starts announces only that run's end", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("/ask delegate");
  // The usual SDK ordering: command acceptance precedes agent_start.
  await env.emit({ type: "prompt_done" });
  assert.deepEqual(env.ended, []);
  await env.emit({ type: "agent_start" }, { type: "agent_end" });
  assert.deepEqual(env.ended, []);
  await env.emit({ type: "agent_settled", aborted: false });
  assert.deepEqual(env.ended, [{ aborted: false }]);
});

test("a command's prompt_done cannot announce the main run it started while a tool/final reply is active", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("/ask delegate");
  await env.emit({ type: "agent_start" }, { type: "tool_execution_start", toolCallId: "outer", toolName: "delegate" });
  // Real SDK commands that call sendUserMessage() are handled independently of
  // the run. Their wrapper prompt can resolve while that run is already active.
  await env.emit({ type: "prompt_done" });
  assert.equal(env.hook.result.agentRunning, true);
  assert.deepEqual(env.ended, [], "a command finishing is not its active main run finishing");
  // The shared CLI extension forwards child message_end only via onUpdate.
  await env.emit({ type: "tool_execution_update", toolCallId: "outer", toolName: "delegate", partialResult: {
    content: [{ type: "text", text: "child finished" }], details: { results: [{ messages: [{ role: "assistant", content: [{ type: "text", text: "child finished" }], stopReason: "stop" }] }] },
  } });
  await env.emit({ type: "tool_execution_end", toolCallId: "outer", toolName: "delegate" });
  assert.deepEqual(env.ended, []);
  await env.emit({ type: "agent_end" });
  assert.deepEqual(env.ended, [], "agent_end alone may continue/retry");
  await env.emit({ type: "agent_settled", aborted: false });
  assert.deepEqual(env.ended, [{ aborted: false }]);
  await env.emit({ type: "prompt_done" }, { type: "agent_settled", aborted: false });
  assert.equal(env.ended.length, 1);
});

test("plain prompt waits for logical settlement, ignores nested progress, and announces once", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("delegate");
  await env.emit({ type: "agent_start" }, { type: "tool_execution_start", toolCallId: "outer", toolName: "delegate" },
    { type: "tool_execution_end", toolCallId: "outer/1", parentToolCallId: "outer", toolName: "anything" }, { type: "agent_end" });
  assert.deepEqual(env.ended, []);
  await env.emit({ type: "agent_settled", aborted: false });
  assert.deepEqual(env.ended, [], "the wrapper prompt is still pending");
  await env.emit({ type: "prompt_done" });
  assert.deepEqual(env.ended, [{ aborted: false }]);
  await env.emit({ type: "prompt_done" });
  assert.equal(env.ended.length, 1);
});

test("idle recovery does not manufacture a run for a handled command", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("/status");
  await env.tick(1_000);
  assert.equal(env.hook.result.agentRunning, false);
  assert.deepEqual(env.ended, []);
});

test("idle recovery retains a stopped run's outcome when prompt_done was missed", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("/ask delegate");
  await env.emit({ type: "agent_start" }, { type: "agent_settled", aborted: true });
  await env.tick(1_000);
  assert.deepEqual(env.ended, [{ aborted: true }]);
});

test("stopped runs and unsettled built-in families keep their suppression, and attention still works", async (t) => {
  const env = await setup(t);
  await env.hook.result.handleSend("delegate");
  await env.emit({ type: "agent_start" }, { type: "extension_ui_request", id: "approve", method: "confirm", title: "Approve?", message: "Continue?" });
  assert.equal(env.attention.length, 1);
  await env.emit({ type: "agent_settled", aborted: true }, { type: "prompt_done", aborted: true });
  assert.deepEqual(env.ended, [{ aborted: true }]);
  await env.hook.result.handleSend("background");
  await env.emit({ type: "agent_start" }, { type: "agent_settled", aborted: false, subagentsActive: true }, { type: "prompt_done", subagentsActive: true });
  assert.deepEqual(env.ended.at(-1), { aborted: false, subagentsActive: true });
  await env.emit({ type: "agent_start" }, { type: "agent_settled", aborted: false });
  assert.deepEqual(env.ended.at(-1), { aborted: false });
  assert.equal(env.ended.length, 3);
});
