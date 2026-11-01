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

async function setup({ fresh = false, subagent = false, familyActive = false } = {}) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const sources = [], commands = [], restores = [], creations = [];
  const server = {
    state: { isStreaming: false, isPromptRunning: false, isStopping: false, subagentsActive: familyActive },
    wrapperPresent: true, noWrapperSubagentsActive: undefined, leaseGate: null,
    historyGate: null, toolsGate: null, creationGate: null, promptGate: null, abortGate: null,
    promptRejected: false, abortLost: false, statusDown: false, ack: null, bashGate: null,
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
      const reply = { running: false, subagentsActive: server.state.subagentsActive };
      await server.leaseGate?.promise;
      return Response.json(reply);
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
      if (cmd.type === "bash") await server.bashGate?.promise;
      if (cmd.type === "abort" || cmd.type === "abort_bash") {
        await server.abortGate?.promise;
        if (server.abortLost) throw new TypeError("lost abort response");
        return Response.json({ success: true, data: { steering: ["recalled"], followUp: [] } });
      }
      return Response.json({ success: true, data: null });
    }
    if (url.startsWith("/api/agent/mode-test")) {
      if (server.statusDown) throw new TypeError("offline");
      return Response.json(server.wrapperPresent
        ? { running: true, state: server.state }
        : { running: false, ...(server.noWrapperSubagentsActive !== undefined ? { subagentsActive: server.noWrapperSubagentsActive } : {}) });
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
    emit: async event => { sources.filter(s => s.readyState === 1).at(-1)?.emit(event); await settle(); hook.flush(); },
    tick: async () => { mock.timers.tick(1000); await settle(); hook.flush(); },
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
    e.hook.result.handleToolPresetChange("full"); // an active submission cannot change its draft
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

test("Stop exposes a local next draft, but early terminal events cannot unlock any send path", async () => {
  await withSetup({}, async e => {
    await e.emit({ type: "agent_start" });
    e.hook.result.handleToolPresetChange("full"); e.hook.flush();
    assert.equal(e.hook.result.toolPreset, "default", "running mode is locked");
    e.server.abortGate = Promise.withResolvers();
    const stopping = e.hook.result.handleAbort(); e.hook.flush();
    assert.equal(e.hook.result.isStopping, true);
    e.hook.result.handleToolPresetChange("read-only"); e.hook.flush();
    assert.equal(e.hook.result.toolPreset, "read-only");
    await e.emit({ type: "agent_end" });
    await e.emit({ type: "agent_settled", aborted: true });
    await e.tick();
    assert.equal(e.hook.result.isStopping, true, "idle snapshots while abort RPC is pending cannot unlock");
    await e.hook.result.handleSend("blocked ordinary", [image]);
    await e.hook.result.handleSteer("blocked steer", [image]);
    await e.hook.result.handleFollowUp("blocked followup");
    await e.hook.result.handlePromptWithStreamingBehavior("blocked slash", "steer");
    assert.equal(e.prompts().length, 0);
    e.server.abortGate.resolve(); await stopping; e.hook.flush();
    assert.equal(e.hook.result.isStopping, false);
    assert.deepEqual(e.restores, ["recalled"]);
    await e.hook.result.handleSend("next plan");
    assert.deepEqual(e.prompts().at(-1).toolNames, PRESET_READ_ONLY);
  });
});

test("Bash Stop uses authoritative abort, keeps the ordinary draft and delays every submission until completion", async () => {
  await withSetup({}, async e => {
    e.server.bashGate = Promise.withResolvers();
    const bash = e.hook.result.handleSend("!fake shell command"); await settle(); e.hook.flush();
    assert.equal(e.hook.result.bashRunning, true);
    setDraft("mode-test", { value: "next text", images: [image] });
    e.server.abortGate = Promise.withResolvers();
    const stopping = e.hook.result.handleAbort(); e.hook.flush();
    assert.equal(e.hook.result.isStopping, true);
    e.hook.result.handleToolPresetChange("read-only");
    assert.equal(e.commands.filter(c => c.type === "abort").length, 1);
    assert.equal(e.commands.filter(c => c.type === "abort_bash").length, 0);
    assert.equal(getDraft("mode-test").value, "next text");
    assert.equal(getDraft("mode-test").images[0].data, image.data);
    e.server.abortGate.resolve(); await stopping;
    e.server.bashGate.resolve(); await bash; e.hook.flush();
    assert.equal(e.hook.result.isStopping, false);
    assert.equal(e.hook.result.bashRunning, false);
    assert.equal(e.hook.result.toolPreset, "read-only");
    assert.equal(e.prompts().length, 0);
  });
});

test("lost abort response stays blocked when unknown or descendants remain; read-only idle confirmation unlocks", async () => {
  await withSetup({}, async e => {
    await e.emit({ type: "agent_start" });
    e.server.abortLost = true; await e.hook.result.handleAbort(); e.hook.flush();
    e.server.statusDown = true; await e.tick();
    assert.equal(e.hook.result.isStopping, true);
    e.server.statusDown = false; e.server.state.subagentsActive = true; await e.tick();
    assert.equal(e.hook.result.isStopping, true);
    e.server.state.subagentsActive = false; await e.tick();
    assert.equal(e.hook.result.isStopping, false, "running:true means a live wrapper, not an active turn");
    assert.equal(e.commands.filter(c => c.type === "abort").length, 1);
    assert.equal(e.prompts().length, 0);
  });
});

test("no-wrapper stop recovery requires explicit top-level child inactivity, never true or unknown", async () => {
  await withSetup({}, async e => {
    e.server.abortLost = true; await e.hook.result.handleAbort(); e.hook.flush();
    e.server.wrapperPresent = false;
    for (const active of [true, undefined]) {
      e.server.noWrapperSubagentsActive = active; await e.tick();
      assert.equal(e.hook.result.isStopping, true);
    }
    e.server.noWrapperSubagentsActive = false; await e.tick();
    assert.equal(e.hook.result.isStopping, false);
    assert.equal(e.commands.filter(c => c.type === "abort").length, 1);
  });
});

test("idle parents retain separate child activity, lock modes and allow tool-free steering until whole-task Stop", async () => {
  await withSetup({}, async e => {
    await e.emit({ type: "agent_start" });
    e.server.state.subagentsActive = true;
    await e.emit({ type: "agent_settled", subagentsActive: true });
    await e.emit({ type: "prompt_done", subagentsActive: true });
    assert.equal(e.hook.result.agentRunning, false, "child activity is not parent model time");
    assert.equal(e.hook.result.subagentsActive, true);
    e.hook.result.handleToolPresetChange("full"); e.hook.flush();
    assert.equal(e.hook.result.toolPreset, "default");
    await e.hook.result.handleSend("blocked ordinary mode override");
    assert.equal(e.prompts().length, 0);
    await e.hook.result.handleSteer("steer parent while children run");
    assert.equal(e.prompts()[0].streamingBehavior, "steer");
    assert.equal(Object.hasOwn(e.prompts()[0], "toolNames"), false);
    await e.hook.result.handleAbort(); e.hook.flush();
    assert.equal(e.commands.filter(c => c.type === "abort").length, 1);
    assert.equal(e.hook.result.subagentsActive, false);
    assert.equal(e.hook.result.agentRunning, false);
  });
});

test("mount/lease snapshots track child-only tasks and a late false lease cannot undo a newer settled event", async () => {
  await withSetup({ familyActive: true }, async e => {
    assert.equal(e.hook.result.subagentsActive, true);
    assert.equal(e.hook.result.agentRunning, false);
    await e.emit({ type: "agent_settled", subagentsActive: false });
    assert.equal(e.hook.result.subagentsActive, false, "final authoritative settlement clears the family");
    e.server.state.subagentsActive = false;
    e.server.leaseGate = Promise.withResolvers();
    document.dispatchEvent(new Event("visibilitychange")); await settle();
    await e.emit({ type: "agent_settled", subagentsActive: true });
    e.server.leaseGate.resolve(); await settle(); e.hook.flush();
    assert.equal(e.hook.result.subagentsActive, true, "pre-event idle snapshot is stale");
    e.server.leaseGate = null; e.server.state.subagentsActive = false;
    document.dispatchEvent(new Event("visibilitychange")); await settle(); e.hook.flush();
    assert.equal(e.hook.result.subagentsActive, false, "a fresh authoritative lease clears idle child activity");
    assert.equal(e.hook.result.agentRunning, false);
  });
});

test("definite rejection restores text/images ahead of newer draft, preserving a newer mode chosen during Stop", async () => {
  await withSetup({}, async e => {
    e.hook.result.handleToolPresetChange("read-only");
    e.server.promptGate = Promise.withResolvers(); e.server.promptRejected = true;
    const sending = e.hook.result.handleSend("rejected plan", [image]); await settle();
    e.server.abortGate = Promise.withResolvers();
    const stopping = e.hook.result.handleAbort();
    e.hook.result.handleToolPresetChange("full");
    setDraft("mode-test", { value: "newer text", images: [] });
    e.server.promptGate.resolve(); await sending; await settle(); e.hook.flush();
    assert.deepEqual(e.prompts()[0].toolNames, PRESET_READ_ONLY);
    assert.equal(e.hook.result.toolPreset, "full");
    assert.equal(getDraft("mode-test").value, "rejected plan\n\nnewer text");
    assert.equal(getDraft("mode-test").images[0].data, image.data);
    assert.ok(e.hook.result.notices.some(n => n.message === "busy"));
    e.server.abortGate.resolve(); await stopping;
  });
});

test("a successful ACK for an older prompt keeps a newer mode chosen while it was stopping", async () => {
  await withSetup({}, async e => {
    e.hook.result.handleToolPresetChange("read-only");
    e.server.promptGate = Promise.withResolvers();
    const sending = e.hook.result.handleSend("older plan prompt"); await settle();
    e.server.abortGate = Promise.withResolvers();
    const stopping = e.hook.result.handleAbort();
    e.hook.result.handleToolPresetChange("full");
    // The accepted plan submission returns while Stop is still unwinding.
    e.server.promptGate.resolve(); await sending; await settle(); e.hook.flush();
    assert.equal(e.hook.result.toolPreset, "full");
    e.server.abortGate.resolve(); await stopping; await settle(); e.hook.flush();
    assert.equal(e.hook.result.isStopping, false);
    await e.hook.result.handleSend("next full prompt"); await settle(); e.hook.flush();
    assert.deepEqual(e.prompts().map(prompt => prompt.toolNames), [PRESET_READ_ONLY, ["bash", "read", "edit", "write", "grep", "find", "ls"]]);
    assert.equal(e.hook.result.toolPreset, "full");
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

test("Stop during fresh creation cannot dispatch the captured prompt even after abort completes", async () => {
  await withSetup({ fresh: true }, async e => {
    e.server.creationGate = Promise.withResolvers();
    const sending = e.hook.result.handleSend("not dispatched", [image]);
    const stopping = e.hook.result.handleAbort(); e.hook.flush();
    assert.equal(e.hook.result.isStopping, true);
    e.hook.result.handleToolPresetChange("full");
    e.server.creationGate.resolve(); await settle(); await stopping;
    await e.connect(); await sending; e.hook.flush();
    assert.equal(e.prompts().length, 0);
    assert.equal(e.hook.result.toolPreset, "full");
    assert.equal(e.hook.result.isStopping, false);
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
