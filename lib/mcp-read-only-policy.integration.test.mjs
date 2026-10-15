import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// The MCP extension keeps its log and OAuth store in the agent directory.
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-read-only-mcp-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rm(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createPiWebBuiltinExtensions } = await jiti.import("./builtin-extensions.ts");
const { createReadOnlyMcpPolicyExtension } = await jiti.import("./mcp-read-only-policy.ts");
const { appendSessionToolSelection } = await jiti.import("./session-tool-selection.ts");

const FIXTURE = fileURLToPath(new URL("./__fixtures__/mcp-env-server.mjs", import.meta.url));
const READ_ONLY = ["read", "grep", "find", "ls"];
const BLOCKED = /Tool "?mcp__(direct|scripted)__(record|env_has)"? (?:is disabled in this session's (?:plan|build) mode|not found)/;

// `direct` declares its tools to the model; `scripted` leaves them to codemode scripts.
const registerFixtureServers = {
  name: "registers-fixture-servers",
  factory: (pi) => {
    pi.registerMcpServer("direct", { command: process.execPath, args: [FIXTURE], exposure: "direct" });
    pi.registerMcpServer("scripted", { command: process.execPath, args: [FIXTURE] });
  },
};

async function waitFor(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await delay(20);
  }
}

async function startSession(t, selection) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-read-only-mcp-cwd-"));
  const faux = fauxProvider({ models: [{ id: "faux-read-only" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      ...(await createPiWebBuiltinExtensions({ agentDir })).extensions,
      createReadOnlyMcpPolicyExtension(),
      registerFixtureServers,
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-read-only"),
    sessionManager,
    settingsManager,
    resourceLoader,
  });
  const wrapper = new AgentSessionWrapper(session);
  t.after(async () => {
    wrapper.destroy();
    await rm(cwd, { recursive: true, force: true });
  });
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  // Connection completion registers tools; ready may already have reset the
  // active set to build, so do not use activation as a connection signal.
  await waitFor(() => ["mcp__direct__record", "mcp__scripted__record"].every((name) =>
    session.getAllTools().some((tool) => tool.name === name),
  ));
  if (selection) {
    appendSessionToolSelection(sessionManager, selection);
    wrapper.setActiveToolSelection(selection);
  }
  return { session, faux };
}

function toolResults(session) {
  return session.messages.filter((message) => message.role === "toolResult");
}

function textOf(message) {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

test("a plan session blocks all MCP tools, including those marked read-only", async (t) => {
  const { session, faux } = await startSession(t, READ_ONLY);
  faux.setResponses([
    () => fauxAssistantMessage([
      fauxToolCall("mcp__direct__record", { note: "change" }, { id: "call-record" }),
      fauxToolCall("mcp__direct__env_has", { name: "PATH" }, { id: "call-env" }),
    ], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  await session.prompt("use the tools");

  const [record, env] = toolResults(session);
  assert.equal(record.toolCallId, "call-record");
  assert.equal(record.isError, true);
  assert.match(textOf(record), BLOCKED);
  assert.equal(env.toolCallId, "call-env");
  assert.equal(env.isError, true);
  assert.match(textOf(env), BLOCKED);
});

test("plan cannot invoke codemode to bypass the mode", async (t) => {
  const { session, faux } = await startSession(t, READ_ONLY);
  const code = [
    "const allowed = await tools.mcp__scripted__env_has({ name: \"PATH\" });",
    "const blocked = await tools.mcp__scripted__record({ note: \"change\" }).then(() => \"ran\", (error) => error.message);",
    "return { allowed: allowed.structuredContent.has, blocked };",
  ].join("\n");
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "call-script" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  await session.prompt("run a script");

  const [script] = toolResults(session);
  assert.equal(script.isError, true);
  assert.match(textOf(script), /codemode|not found|not active/i);
});

test("full codemode still executes nested fixture MCP calls through the builtin transport", async (t) => {
  const { session, faux } = await startSession(t, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  const code = [
    'const env = await tools.mcp__scripted__env_has({ name: "PATH" });',
    'const record = await tools.mcp__scripted__record({ note: "nested" });',
    "return { has: env.structuredContent.has, recorded: record.structuredContent.recorded };",
  ].join("\n");
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "call-script" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  await session.prompt("run a full-mode script");
  const [script] = toolResults(session);
  assert.equal(script.toolCallId, "call-script");
  assert.equal(script.isError, false, textOf(script));
  assert.deepEqual(JSON.parse(script.content.at(-1).text), { has: true, recorded: "nested" });
});

test("only full admits MCP calls; unpinned and build block them", async (t) => {
  for (const selection of [undefined, ["read", "bash", "edit", "write"], ["read", "bash", "edit", "write", "grep", "find", "ls"]]) {
    const { session, faux } = await startSession(t, selection);
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("mcp__direct__record", { note: "change" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("done")]),
    ]);
    await session.prompt("use the tool");
    const [record] = toolResults(session);
    const full = selection?.length === 7;
    assert.equal(record.isError, !full, `${JSON.stringify(selection)}: ${textOf(record)}`);
    if (full) assert.match(textOf(record), /"recorded":"change"/);
    else assert.match(textOf(record), BLOCKED);
  }
});
