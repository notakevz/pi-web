import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const dir = await mkdtemp(join(tmpdir(), "pi-web-mode-submit-"));
process.env.PI_CODING_AGENT_DIR = dir;
test.after(() => rm(dir, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: { "@": process.cwd() } });
const { AgentSessionWrapper, sendRpcSessionPrompt } = await jiti.import("./rpc-manager.ts");
const { createReadOnlyMcpPolicyExtension } = await jiti.import("./mcp-read-only-policy.ts");
const { appendSessionToolSelection, readSessionToolSelection } = await jiti.import("./session-tool-selection.ts");

const PLAN = ["read", "grep", "find", "ls"];
const BUILD = ["read", "bash", "edit", "write"];
const FULL = [...BUILD, "grep", "find", "ls"];
const sorted = (names) => [...names].sort();

async function waitForWrapperIdle(wrapper) {
  const deadline = Date.now() + 10_000;
  while (wrapper.isRunning()) {
    assert.ok(Date.now() < deadline, "wrapper prompt did not settle");
    await delay(10);
  }
}

async function createSession(t, selection, extensionFactories = []) {
  const fixtures = { name: "mode-submit-fixtures", factory: (pi) => {
    for (const tool of [
      { name: "lookup", description: "untrusted extension" },
      { name: "subagent", description: "In plan/build, children cannot load extensions or MCP" },
      { name: "webfetch", description: "Read-only webfetch: fixture", annotations: { readOnlyHint: true } },
    ]) pi.registerTool({
      ...tool, label: tool.name, parameters: { type: "object", additionalProperties: true },
      async execute() { return { content: [{ type: "text", text: "fixture ran" }], details: undefined }; },
    });
  } };
  const faux = fauxProvider({ models: [{ id: "faux-local" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    extensionFactories: [fixtures, ...extensionFactories, createReadOnlyMcpPolicyExtension(() => settingsManager.getDefaultTools())],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(dir);
  if (selection !== undefined) appendSessionToolSelection(sessionManager, selection);
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel("faux-local"), settingsManager, resourceLoader, sessionManager,
  });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  function responses() {
    faux.setResponses([
      () => fauxAssistantMessage([fauxText("done")]),
      () => fauxAssistantMessage([fauxText("done")]),
    ]);
  }
  return { session, wrapper, faux, responses };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function registerForModeSubmission(t, wrapper) {
  const registry = globalThis.__piSessions ??= new Map();
  registry.set(wrapper.sessionId, wrapper);
  t.after(() => { if (registry.get(wrapper.sessionId) === wrapper) registry.delete(wrapper.sessionId); });
}

test("Send applies its captured mode in the same admission, without a separate set_tools", async (t) => {
  const { session, wrapper, responses } = await createSession(t, FULL);
  registerForModeSubmission(t, wrapper);
  responses();
  await sendRpcSessionPrompt(session.sessionId, undefined, { type: "prompt", message: "plan this change", toolNames: PLAN });
  await waitForWrapperIdle(wrapper);
  assert.deepEqual(readSessionToolSelection(session.sessionManager.getEntries()), PLAN);
  assert.deepEqual(sorted(session.getActiveToolNames()), sorted([...PLAN, "subagent", "webfetch"]));
  assert.match(session.agent.state.systemPrompt, /Current tool mode: plan/);
  responses();
  await sendRpcSessionPrompt(session.sessionId, undefined, { type: "prompt", message: "implement now", toolNames: BUILD });
  await waitForWrapperIdle(wrapper);
  assert.deepEqual(readSessionToolSelection(session.sessionManager.getEntries()), BUILD);
  assert.ok(session.getActiveToolNames().includes("write"));
});

test("queued messages and invalid mode submissions cannot mutate a run's tools", async (t) => {
  const { session, wrapper } = await createSession(t, BUILD);
  for (const command of [
    { streamingBehavior: "steer", toolNames: PLAN },
    { streamingBehavior: "followUp", toolNames: PLAN },
    { toolNames: ["lookup"] },
    { toolNames: PLAN, images: [{ type: "image", data: "invalid", mimeType: "text/plain" }] },
  ]) {
    await assert.rejects(wrapper.send({ type: "prompt", message: "must not submit", ...command }));
    assert.deepEqual(readSessionToolSelection(session.sessionManager.getEntries()), BUILD);
  }
});

test("concurrent mode submissions reject the later one while the accepted run remains active", async (t) => {
  const entered = deferred(), input = deferred(), model = deferred();
  const gate = { name: "input-admission-gate", factory: (pi) => {
    pi.on("input", async (event) => {
      if (event.text === "first") { entered.resolve(); await input.promise; }
      return { action: "continue" };
    });
  } };
  const { session, wrapper, faux } = await createSession(t, FULL, [gate]);
  registerForModeSubmission(t, wrapper);
  t.after(() => { input.resolve(); model.resolve(); });
  faux.setResponses([async () => { await model.promise; return fauxAssistantMessage([fauxText("done")]); }]);
  const first = sendRpcSessionPrompt(session.sessionId, undefined, { type: "prompt", message: "first", toolNames: BUILD });
  await entered.promise;
  const second = sendRpcSessionPrompt(session.sessionId, undefined, { type: "prompt", message: "second", toolNames: PLAN });
  const refused = assert.rejects(second, /task is running/);
  input.resolve();
  await first;
  await refused;
  assert.deepEqual(readSessionToolSelection(session.sessionManager.getEntries()), BUILD);
  model.resolve();
  await waitForWrapperIdle(wrapper);
});

test("prompt route commits the submitted mode and returns definitive rejection without changing it on invalid input", async (t) => {
  const { session, wrapper, responses } = await createSession(t, BUILD);
  registerForModeSubmission(t, wrapper);
  const { POST } = await jiti.import("../app/api/agent/[id]/route.ts");
  const send = (body) => POST(new Request(`http://localhost/api/agent/${session.sessionId}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: session.sessionId }) });
  responses();
  const accepted = await send({ type: "prompt", message: "plan via route", toolNames: PLAN });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).success, true);
  await waitForWrapperIdle(wrapper);
  assert.deepEqual(readSessionToolSelection(session.sessionManager.getEntries()), PLAN);
  for (const extra of [{ toolNames: ["not-a-tool"] }, { toolNames: BUILD, streamingBehavior: "steer" }]) {
    const rejected = await send({ type: "prompt", message: "refuse this submission", ...extra });
    assert.equal(rejected.status, 500);
    const body = await rejected.json();
    assert.equal(body.code, "prompt_rejected");
    assert.equal(body.accepted, false);
    assert.deepEqual(readSessionToolSelection(session.sessionManager.getEntries()), PLAN);
  }
});
