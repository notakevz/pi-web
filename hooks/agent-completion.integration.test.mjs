import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJiti } from "jiti";

const shim = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shim } });
const { renderHook } = await import(pathToFileURL(shim).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { AgentSessionWrapper } = await jiti.import("../lib/rpc-manager.ts");
const tick = () => new Promise(setImmediate);
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for notification fixture");
    await tick();
  }
}

// The shared CLI extension's child boundary is stdout JSON -> onUpdate, NOT
// forwarding child lifecycle events. Keep that boundary in a portable local
// fixture: no shared config, credentials, provider network, or child session.
function cliStyleDelegate(pi) {
  pi.registerCommand("ask", { handler: async (args) => pi.sendUserMessage(args) });
  pi.registerTool({
    name: "delegate", label: "Delegate", description: "Local child fixture", parameters: Type.Object({}),
    async execute(_id, _args, _signal, onUpdate) {
      const events = [
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "child finished" }], stopReason: "stop" } },
        { type: "agent_end" }, { type: "agent_settled", aborted: false },
      ];
      const child = spawn(process.execPath, ["-e", "process.stdout.write(process.argv[1])", events.map((event) => JSON.stringify(event)).join("\n") + "\n"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Child exited ${code}`))); });
      for (const line of output.trim().split("\n")) {
        const event = JSON.parse(line);
        if (event.type === "message_end") onUpdate?.({ content: event.message.content, details: { results: [{ messages: [event.message] }] } });
      }
      return { content: [{ type: "text", text: "child finished" }] };
    },
  });
}

for (const { message, disconnected = false } of [
  { message: "Delegate locally" },
  { message: "/ask Delegate locally" },
  { message: "/ask Delegate locally", disconnected: true },
]) {
  test(`real SDK + CLI-style child: ${message}${disconnected ? " (SSE disconnected)" : ""} announces only the final main completion`, { timeout: 20_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-browser-completion-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    t.after(async () => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(dir, { recursive: true, force: true });
    });
    const faux = fauxProvider({ models: [{ id: "parent-completion" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, extensionFactories: [cliStyleDelegate], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), sessionManager: SessionManager.inMemory(dir), settingsManager, resourceLoader });
    // Explicitly choose full mode for this arbitrary extension tool; do not
    // weaken the candidate's build-mode permission policy for a test fixture.
    session.sessionManager.appendCustomEntry("pi-web:tool-selection", { version: 1, tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] });
    const pushed = [], ended = [], events = [], sources = [], snapshots = [];
    const wrapper = new AgentSessionWrapper(session, { onAgentRunComplete: (id) => pushed.push(id) });
    t.after(() => wrapper.destroy());
    wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "hidden" });
    globalThis.window ??= new EventTarget();
    globalThis.EventSource = class {
      readyState = 0;
      constructor() {
        sources.push(this);
        queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", sessionId: session.sessionId, isStreaming: false }) }); });
      }
      close() { this.readyState = 2; }
    };
    const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    globalThis.fetch = async (url, init = {}) => {
      if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
      if (url.endsWith("/state") || url.startsWith("/api/agent/")) {
        if (init.body) return json({ success: true, data: await wrapper.send(JSON.parse(init.body)) });
        const state = await wrapper.send({ type: "get_state" });
        snapshots.push(state);
        return json({ running: wrapper.isRunning(), state });
      }
      return json({ sessionId: session.sessionId, tree: [], leafId: null, context: { messages: [], entryIds: [] } });
    };
    const hook = renderHook(useAgentSession, { session: { id: session.sessionId, cwd: dir, name: "Parent" }, onAgentEnd: (end) => ended.push(end) });
    t.after(() => hook.unmount());
    wrapper.onEvent((event) => {
      events.push(event);
      if (!disconnected) for (const source of sources) if (source.readyState === 1) source.onmessage?.({ data: JSON.stringify(event) });
    });
    for (let i = 0; i < 10; i++) await tick();
    hook.flush();
    const final = Promise.withResolvers();
    t.after(() => final.resolve());
    let finalEntered = false;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("delegate", {})], { stopReason: "toolUse" }),
      async () => { finalEntered = true; await final.promise; return fauxAssistantMessage("parent final"); },
    ]);
    await hook.result.handleSend(message);
    await until(() => finalEntered);
    assert.ok(events.some((event) => event.type === "tool_execution_update" && event.partialResult.content[0].text === "child finished"), JSON.stringify(events.filter((event) => event.type.startsWith("tool_") || event.message?.role === "toolResult")));
    assert.equal(wrapper.isRunning(), true);
    assert.deepEqual(pushed, []);
    assert.deepEqual(ended, [], "child/command completion must not announce before the final main response");
    // In the disconnected case no agent_start/end/settled/prompt_done reaches
    // the hook: the fast settlement poll must observe, then finish, the run.
    if (disconnected) await until(() => snapshots.some((state) => state.isStreaming));
    final.resolve();
    await until(() => !wrapper.isRunning());
    if (disconnected) await until(() => ended.length === 1);
    await tick();
    assert.deepEqual(pushed, [session.sessionId]);
    assert.deepEqual(ended, [{ aborted: false }]);
    assert.equal(session.getLastAssistantText(), "parent final");
  });
}
