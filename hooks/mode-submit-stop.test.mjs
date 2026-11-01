import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shim = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shim } });
const { renderHook } = await import(shim);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { PRESET_READ_ONLY, PRESET_DEFAULT } = await jiti.import("@/lib/tool-presets");
const { clearDraft, getDraft, setDraft, restoreDraftSubmission } = await jiti.import("@/lib/draft-store");
const { deleteSessionViewSnapshot } = await jiti.import("@/lib/session-view-cache");
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();
const image = { data: "AQID", mimeType: "image/png", previewUrl: "blob:image" };

async function setup({ fresh = false, subagent = false } = {}) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const sources = [], commands = [], restores = [], creations = [];
  const server = {
    state: { isStreaming: false, isPromptRunning: false },
    historyGate: null, toolsGate: null, creationGate: null, promptGate: null,
    promptRejected: false, ack: null,
  };
  globalThis.EventSource = class {
    readyState = 0;
    constructor() { sources.push(this); }
    close() { this.readyState = 2; }
    emit(event) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(event) }); }
  };
  globalThis.fetch = async (url, init = {}) => {
    if (url.startsWith("/api/models")) return Response.json({ models: {}, modelList: [] });
    if (url === "/api/agent/new") { creations.push(JSON.parse(init.body)); await server.creationGate?.promise; return Response.json({ sessionId: "mode-test" }); }
    if (url.startsWith("/api/sessions/mode-test?")) {
      await server.historyGate?.promise;
      return Response.json({ sessionId: "mode-test", toolNames: PRESET_DEFAULT, leafId: null, tree: [], context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false } });
    }
    if (url === "/api/sessions/mode-test/state") return Response.json({ running: true, state: server.state });
    if (url === "/api/agent/mode-test/lease") {
      return Response.json({ running: false });
    }
    if (url.startsWith("/api/agent/mode-test") && init.body) {
      const cmd = JSON.parse(init.body); commands.push(cmd);
      if (cmd.type === "get_tools") {
        await server.toolsGate?.promise;
        return Response.json({ success: true, data: PRESET_DEFAULT.map(name => ({ name, active: true, description: name })) });
      }
      if (cmd.type === "prompt") {
        await server.promptGate?.promise;
        if (server.promptRejected) return Response.json({ error: "busy", code: "prompt_rejected", accepted: false }, { status: 409 });
        return Response.json({ success: true, data: server.ack });
      }
      return Response.json({ success: true, data: null });
    }
    if (url.startsWith("/api/agent/mode-test")) {
      return Response.json({ running: true, state: server.state });
    }
    return Response.json({});
  };
  const hook = renderHook(useAgentSession, {
    session: fresh ? null : { id: "mode-test", cwd: "/project", ...(subagent ? { relation: { kind: "subagent" } } : {}) },
    newSessionCwd: fresh ? "/project" : null,
    chatInputRef: { current: {
      prependText(text) { restores.push(text); },
      restoreSubmission(text, images, key) { if (key) restoreDraftSubmission(key, text, images); },
      rekeyDraft() {},
    } },
    t: key => key,
  });
  await settle(); hook.flush();
  const connect = async () => {
    for (const s of sources) if (s.readyState === 0) s.emit({ type: "connected", sessionId: "mode-test", isStreaming: false });
    await settle(); hook.flush();
  };
  await connect();
  return { hook, server, commands, restores, creations, connect,
    prompts: () => commands.filter(c => c.type === "prompt"),
    close() { hook.unmount(); mock.timers.reset(); clearDraft("mode-test"); deleteSessionViewSnapshot("mode-test"); },
  };
}

async function withSetup(options, body) {
  const originalError = console.error; console.error = () => {};
  const e = await setup(options);
  try { await body(e); assert.ok(!e.commands.some(c => c.type === "set_tools"), "selection never calls set_tools"); }
  finally { e.close(); console.error = originalError; }
}

test("rapid local picks do not RPC; send freezes its tools before fresh creation awaits", async () => {
  await withSetup({ fresh: true }, async e => {
    e.hook.result.handleToolPresetChange("full");
    e.hook.result.handleToolPresetChange("read-only");
    assert.equal(e.commands.length, 0);
    e.server.creationGate = Promise.withResolvers();
    const send = e.hook.result.handleSend("plan this", [image]);
    e.hook.result.handleToolPresetChange("full"); // a running submission cannot change its draft
    e.server.creationGate.resolve(); await settle(); await e.connect(); await send; e.hook.flush();
    assert.deepEqual(e.prompts()[0].toolNames, PRESET_READ_ONLY);
    assert.equal(e.hook.result.toolPreset, "read-only");
    assert.equal(e.prompts()[0].images[0].data, image.data);
  });
});

test("an earlier ensure_session keeps its initial tools but final prompt owns send-time selection", async () => {
  await withSetup({ fresh: true }, async e => {
    e.server.creationGate = Promise.withResolvers();
    const warming = e.hook.result.loadSlashCommands();
    await settle();
    assert.deepEqual(e.creations[0].toolNames, PRESET_DEFAULT);
    e.hook.result.handleToolPresetChange("read-only");
    const sending = e.hook.result.handleSend("send-time plan");
    e.server.creationGate.resolve(); await warming; await settle(); await e.connect(); await sending;
    assert.deepEqual(e.prompts()[0].toolNames, PRESET_READ_ONLY);
  });
});

test("late tools/history reads never revert an explicitly selected next mode", async () => {
  await withSetup({}, async e => {
    e.server.toolsGate = Promise.withResolvers();
    const loading = e.hook.result.loadTools("mode-test");
    e.hook.result.handleToolPresetChange("full");
    e.server.toolsGate.resolve(); await loading; e.hook.flush();
    assert.equal(e.hook.result.toolPreset, "full");
    e.server.historyGate = Promise.withResolvers();
    // A normal send's rejection reconciliation reloads history.
    e.server.promptRejected = true;
    const sending = e.hook.result.handleSend("rejected", [image]);
    await settle(); await sending;
    e.server.historyGate.resolve(); await settle(); e.hook.flush();
    assert.equal(e.hook.result.toolPreset, "full");
  });
});

test("definite rejection restores text/images ahead of newer draft input", async () => {
  await withSetup({}, async e => {
    e.hook.result.handleToolPresetChange("read-only");
    e.server.promptGate = Promise.withResolvers(); e.server.promptRejected = true;
    const sending = e.hook.result.handleSend("rejected plan", [image]); await settle();
    setDraft("mode-test", { value: "newer text", images: [] });
    e.server.promptGate.resolve(); await sending; await settle(); e.hook.flush();
    assert.deepEqual(e.prompts()[0].toolNames, PRESET_READ_ONLY);
    assert.equal(e.hook.result.toolPreset, "read-only");
    assert.equal(getDraft("mode-test").value, "rejected plan\n\nnewer text");
    assert.equal(getDraft("mode-test").images[0].data, image.data);
    assert.ok(e.hook.result.notices.some(n => n.message === "busy"));
  });
});

test("a recreated prompt ACK adopts its session id and reconnects without a separate mode write", async () => {
  await withSetup({ fresh: true }, async e => {
    e.server.ack = { sessionId: "mode-test-recreated", recreated: true };
    e.hook.result.handleToolPresetChange("read-only");
    const sending = e.hook.result.handleSend("leave historical Chat only");
    await settle(); await e.connect(); await sending; e.hook.flush();
    assert.equal(e.hook.result.sessionIdRef.current, "mode-test-recreated");
    assert.deepEqual(e.prompts()[0].toolNames, PRESET_READ_ONLY);
    assert.equal(e.prompts().length, 1);
  });
});

test("steer/followUp never carry tools, and direct subagent chats retain their immutable profile", async () => {
  await withSetup({}, async e => {
    e.hook.result.handleToolPresetChange("full");
    await e.hook.result.handleSteer("steer"); await e.hook.result.handleFollowUp("follow up");
    assert.equal(e.prompts().length, 2);
    assert.ok(e.prompts().every(p => !Object.hasOwn(p, "toolNames")));
  });
  await withSetup({ subagent: true }, async e => {
    e.hook.result.handleToolPresetChange("full"); e.hook.flush();
    assert.equal(e.hook.result.toolPreset, "default");
    await e.hook.result.handleSend("continue child");
    assert.equal(Object.hasOwn(e.prompts()[0], "toolNames"), false);
  });
});
