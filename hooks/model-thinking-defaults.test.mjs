import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { modelThinkingDefault, clampSupportedThinkingLevel } = await jiti.import("../lib/model-thinking-defaults.ts");
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
const gpt = { provider: "remote", modelId: "gpt-6.1-sol" };
const qwen = { provider: "local", modelId: "qwen3.8-27b" };
const gemma = { provider: "local", modelId: "gemma-4" };
const key = (model) => `${model.provider}/${model.modelId}`;

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();
globalThis.EventSource = class {
  readyState = 0;
  constructor() {
    globalThis.EventSource.latest = this;
    queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); });
  }
  close() { this.readyState = 2; }
};

async function setup({ existing = false, defaults = { [key(gpt)]: "high", [key(qwen)]: "low" }, pins = {}, saveGate, saveError, fallback = "medium", creationGate, modelGate, modelAckGates = {}, thinkingGates = {}, detailGate, failCommand, staleDefaults, backgroundReadGate, backgroundStateGate, agentReadGate, agentFullState, canonicalFailure, reselectLevel, effortReadGate, lostModelReply = false, hookImplementation = useAgentSession, renderImplementation = renderHook } = {}) {
  let catalog = {
    models: {}, modelList: [gpt, qwen, gemma].map(({ provider, modelId }) => ({ provider, id: modelId, name: modelId })),
    defaultModel: gpt, defaultThinkingLevel: defaults[key(gpt)] ?? "medium",
    fallbackThinkingLevel: fallback, savedDefaultThinkingLevel: fallback,
    modelThinkingDefaults: { ...defaults }, thinkingLevelPins: pins,
    thinkingLevels: {
      "remote:gpt-6.1-sol": ["off", "low", "medium", "high", "xhigh"],
      "local:qwen3.8-27b": ["off", "low", "medium", "xhigh"],
      "local:gemma-4": ["off", "medium"],
    },
  };
  const writes = [], commands = [], creations = [], prompts = [], unexpected = [], reads = [];
  let serverModel = gpt, serverLevel = defaults[key(gpt)] ?? "medium";
  let serverSupported;
  const effortReads = [];
  let sessionTools = null;
  // Deliberately stale SDK settings: a live wrapper does not learn star writes by itself.
  const wrapperDefaults = { ...defaults, ...staleDefaults };
  const preferences = new Map([["pi-tool-preset", "full"]]);
  window.localStorage = { getItem: (k) => preferences.get(k) ?? null, setItem: (k, v) => preferences.set(k, v) };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (!body) reads.push(url);
    if (url === "/api/models/default") {
      writes.push(body);
      if (saveGate && body.modelThinkingLevel) await saveGate.promise;
      if (saveError) return Response.json({ error: saveError }, { status: 409 });
      if (body.modelThinkingLevel) {
        const { provider, modelId, level } = body.modelThinkingLevel;
        catalog = { ...catalog, modelThinkingDefaults: { ...catalog.modelThinkingDefaults, [`${provider}/${modelId}`]: level } };
      } else {
        catalog = { ...catalog, defaultModel: { provider: body.provider, modelId: body.modelId } };
      }
      return Response.json({ ok: true });
    }
    if (url.startsWith("/api/models")) return Response.json(catalog);
    if (url === "/api/agent/new") {
      creations.push(body);
      sessionTools = body.toolNames;
      serverModel = body.provider ? { provider: body.provider, modelId: body.modelId } : catalog.defaultModel;
      serverLevel = body.thinkingLevel ?? catalog.thinkingLevelPins[key(serverModel)] ?? catalog.modelThinkingDefaults[key(serverModel)] ?? "medium";
      if (creationGate) await creationGate.promise;
      return Response.json({ sessionId: "model-defaults", model: serverModel, thinkingLevel: serverLevel });
    }
    if (url.startsWith("/api/sessions/model-defaults?")) {
      if (canonicalFailure && commands.some((command) => command.type === "set_model")) {
        if (canonicalFailure === "transport") throw new Error("fixture canonical transport failure");
        return Response.json({ error: "fixture canonical failure" }, { status: 500 });
      }
      const detail = {
        toolNames: sessionTools ?? ["read", "bash", "edit", "write"], leafId: null, tree: [],
        context: { model: serverModel, thinkingLevel: serverLevel, messages: [], entryIds: [], hasMore: false, oldestEntryId: null },
      };
      if (detailGate && commands.some((command) => command.type === "set_model")) await detailGate.promise;
      if (backgroundReadGate && !url.includes("force=1") && !commands.some((command) => command.type === "set_model")) await backgroundReadGate.promise;
      return Response.json(detail);
    }
    if (url === "/api/sessions/model-defaults/state") {
      const state = { model: { provider: serverModel.provider, id: serverModel.modelId }, thinkingLevel: serverLevel };
      if (backgroundStateGate && !commands.some((command) => command.type === "set_model")) await backgroundStateGate.promise;
      return Response.json({ running: false, state });
    }
    if (!body && (url === "/api/agent/model-defaults?systemPrompt=0" || url === "/api/agent/model-defaults")) {
      const state = { model: { provider: serverModel.provider, id: serverModel.modelId }, thinkingLevel: serverLevel,
        ...(url === "/api/agent/model-defaults" ? agentFullState : {}) };
      if (agentReadGate && url === "/api/agent/model-defaults") await agentReadGate.promise;
      if (url.endsWith("?systemPrompt=0") && commands.some((c) => c.type === "set_model")
        && commands.at(-1)?.type === "set_thinking_level") {
        effortReads.push(state);
        if (effortReadGate) await effortReadGate.promise;
      }
      return Response.json({ running: false, state });
    }
    if (url === "/api/agent/model-defaults" && body) {
      commands.push(body);
      if (body.type === failCommand) throw new Error(`fixture failure: ${failCommand}`);
      let data = {};
      if (body.type === "set_model") {
        const sameModel = serverModel.provider === body.provider && serverModel.modelId === body.modelId;
        serverModel = { provider: body.provider, modelId: body.modelId };
        serverLevel = sameModel ? (reselectLevel ?? serverLevel) : (wrapperDefaults[key(serverModel)] ?? fallback ?? serverLevel);
        // Simulate a saved definition that no longer reasons: the SDK clamps
        // every later effort write too, not just the set_model response.
        serverSupported = sameModel && reselectLevel === "off" ? ["off"] : undefined;
        data = { provider: body.provider, id: body.modelId };
        const ackGate = modelAckGates[commands.filter((command) => command.type === "set_model").length] ?? modelGate;
        if (ackGate) await ackGate.promise;
        if (lostModelReply) throw new Error("fixture lost model reply");
      }
      if (body.type === "set_thinking_level") {
        serverLevel = clampSupportedThinkingLevel(body.level, serverSupported); data = null;
        if (thinkingGates[body.level]) await thinkingGates[body.level].promise;
      }
      if (body.type === "prompt") prompts.push({ model: serverModel, level: serverLevel });
      if (body.type === "get_state") data = { model: { ...serverModel, id: serverModel.modelId }, thinkingLevel: serverLevel };
      if (body.type === "get_tools") data = (sessionTools ?? ["read", "bash", "edit", "write"]).map((name) => ({ name, active: true }));
      return Response.json({ success: true, data });
    }
    unexpected.push(`${init.method ?? "GET"} ${url}`);
    throw new Error(`unexpected fetch ${url}`);
  };
  const props = existing ? { session: { id: "model-defaults", cwd: "/project" } }
    : { session: null, newSessionCwd: "/project", newSessionDraftKey: "new:defaults" };
  let systemInfoLoader;
  const choices = [];
  const hook = renderImplementation(hookImplementation, { ...props,
    onSystemInfoLoaderChange: (loader) => { systemInfoLoader = loader; },
    onNewSessionChoicesChange: (value) => choices.push(value),
  });
  const unmount = hook.unmount;
  hook.unmount = () => { unmount(); assert.deepEqual(unexpected, [], "hook must not swallow mock URL mismatches"); };
  await settle(); hook.flush();
  const events = globalThis.EventSource.latest;
  return { hook, writes, commands, creations, preferences, prompts, reads, choices, effortReads, initialize: () => systemInfoLoader(), catalog: () => catalog, serverLevel: () => serverLevel,
    emit: (event) => events.onmessage({ data: JSON.stringify(event) }) };
}

test("fresh chats resolve the default model's effort; model switches use each model's own star", async () => {
  const { hook, writes } = await setup();
  try {
    assert.equal(hook.result.toolPreset, "default");
    assert.equal(hook.result.thinkingLevel, "high");
    assert.equal(hook.result.savedDefaultThinkingLevel, "high");
    await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
    assert.equal(hook.result.thinkingLevel, "low");
    assert.equal(hook.result.savedDefaultThinkingLevel, "low");
    await hook.result.handleThinkingLevelChange("xhigh"); hook.flush();
    assert.equal(hook.result.thinkingLevel, "xhigh");
    assert.equal(hook.result.savedDefaultThinkingLevel, "low", "ordinary choices do not change the star");
    await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
    assert.equal(hook.result.thinkingLevel, "high", "temporary Qwen effort must not stick to GPT");
    await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
    assert.equal(hook.result.thinkingLevel, "low");
    assert.deepEqual(writes, []);
  } finally { hook.unmount(); }
});

test("reasoning star saves only this provider/model; model star saves only the new-chat model", async () => {
  const state = await setup(); const { hook, writes } = state;
  try {
    await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
    await hook.result.handleSetDefaultThinkingLevel("xhigh"); await settle(); hook.flush();
    assert.deepEqual(writes[0], { cwd: "/project", modelThinkingLevel: { ...qwen, level: "xhigh" } });
    assert.deepEqual(state.catalog().defaultModel, gpt);
    assert.equal(state.catalog().savedDefaultThinkingLevel, "medium");
    assert.equal(state.catalog().modelThinkingDefaults[key(gpt)], "high");
    assert.equal(hook.result.savedDefaultThinkingLevel, "xhigh");
    await hook.result.handleSetDefaultModel(qwen.provider, qwen.modelId); await settle(); hook.flush();
    assert.deepEqual(writes[1], { cwd: "/project", ...qwen });
    assert.equal(state.catalog().modelThinkingDefaults[key(qwen)], "xhigh");
  } finally { hook.unmount(); }
});

test("off is a model-bound default for both Qwen and Gemma", async () => {
  const { hook } = await setup({ defaults: { [key(gpt)]: "high", [key(qwen)]: "off", [key(gemma)]: "off" } });
  try {
    for (const model of [qwen, gemma]) {
      await hook.result.handleModelChange(model.provider, model.modelId); hook.flush();
      assert.equal(hook.result.thinkingLevel, "off");
      assert.equal(hook.result.savedDefaultThinkingLevel, "off");
    }
    await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
    assert.equal(hook.result.thinkingLevel, "high");
  } finally { hook.unmount(); }
});

test("starting a fresh chat sends its selected model and build tools, without turning resolved effort into an override", async () => {
  const { hook, creations, serverLevel, initialize } = await setup();
  try {
    await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
    await initialize(); hook.flush();
    assert.deepEqual(creations[0].toolNames, ["read", "bash", "edit", "write"]);
    assert.equal(creations[0].modelId, qwen.modelId);
    assert.equal(creations[0].thinkingLevel, undefined, "SDK resolves the native saved default atomically");
    assert.equal(serverLevel(), "low");
  } finally { hook.unmount(); }
});

test("a dormant initialized fresh chat and a restored chat apply newly saved effort despite stale wrapper settings", async () => {
  for (const existing of [false, true]) {
    const { hook, serverLevel, commands, initialize } = await setup({ existing });
    try {
      if (!existing) { await initialize(); hook.flush(); }
      await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
      await hook.result.handleSetDefaultThinkingLevel("xhigh"); await settle(); hook.flush();
      await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
      await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
      assert.equal(serverLevel(), "xhigh");
      assert.equal(hook.result.thinkingLevel, "xhigh");
      const lastSwitch = commands.findLastIndex((command) => command.type === "set_model");
      assert.deepEqual(commands[lastSwitch + 1], { type: "set_thinking_level", level: "xhigh" });
    } finally { hook.unmount(); }
  }
});

test("a star save completing after a model switch updates A's preference without changing B's effort", async () => {
  const saveGate = Promise.withResolvers();
  const { hook, writes } = await setup({ saveGate });
  try {
    const saving = hook.result.handleSetDefaultThinkingLevel("xhigh");
    await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
    saveGate.resolve(); await saving; await settle(); hook.flush();
    assert.equal(writes[0].modelThinkingLevel.modelId, gpt.modelId);
    assert.equal(hook.result.thinkingLevel, "low");
    assert.equal(hook.result.savedDefaultThinkingLevel, "low");
    await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
    assert.equal(hook.result.thinkingLevel, "xhigh");
  } finally { hook.unmount(); }
});

test("failed star saves do not move the marker or overwrite a temporary selection", async () => {
  const { hook } = await setup({ saveError: "project override" });
  try {
    await hook.result.handleSetDefaultThinkingLevel("low"); hook.flush();
    assert.equal(hook.result.thinkingLevel, "high");
    assert.equal(hook.result.savedDefaultThinkingLevel, "high");
  } finally { hook.unmount(); }
});

test("tool changes affect this chat only; remounting a fresh chat starts in build", async () => {
  const { hook, preferences, writes } = await setup();
  try {
    await hook.result.handleToolPresetChange("full"); hook.flush();
    assert.equal(hook.result.toolPreset, "full");
    assert.equal(preferences.get("pi-tool-preset"), "full", "legacy browser data is neither read nor rewritten");
    assert.deepEqual(writes, []);
  } finally { hook.unmount(); }
  const fresh = await setup();
  try { assert.equal(fresh.hook.result.toolPreset, "default"); }
  finally { fresh.hook.unmount(); }
});

test("resolution keeps exact provider keys, pins and global fallback separate and clamps like pi", () => {
  const supported = ["off", "low", "medium", "xhigh"];
  assert.equal(modelThinkingDefault(qwen, {}, { [key(qwen)]: "low" }, "high", supported), "low");
  assert.equal(modelThinkingDefault(qwen, { [key(qwen)]: "xhigh" }, { [key(qwen)]: "low" }, "medium", supported), "xhigh");
  assert.equal(modelThinkingDefault({ ...qwen, provider: "other" }, {}, { [key(qwen)]: "low" }, "high", supported), "xhigh");
  assert.equal(modelThinkingDefault(qwen, {}, {}, null, supported), null);
  assert.equal(clampSupportedThinkingLevel("off", ["medium"]), "medium");
  assert.equal(clampSupportedThinkingLevel("max", ["off", "low"]), "low");
});

test("switching without any saved default resets a previous model's temporary effort to the concrete startup fallback", async () => {
  for (const existing of [false, true]) {
    const { hook, initialize, serverLevel } = await setup({ existing, defaults: {}, fallback: null });
    try {
      if (!existing) { await initialize(); hook.flush(); }
      await hook.result.handleThinkingLevelChange("xhigh"); hook.flush();
      await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
      assert.equal(hook.result.thinkingLevel, "medium");
      assert.equal(serverLevel(), "medium", "SDK's inherited xhigh must be replaced too");
      assert.equal(hook.result.savedDefaultThinkingLevel, null, "a fallback is not a saved star");
    } finally { hook.unmount(); }
  }
});

test("the first prompt of an initialized draft preserves a new star or temporary effort instead of re-running stale set_model", async () => {
  for (const saveStar of [false, true]) {
    const { hook, initialize, commands, prompts } = await setup();
    try {
      await initialize(); hook.flush();
      await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
      if (saveStar) await hook.result.handleSetDefaultThinkingLevel("xhigh");
      else await hook.result.handleThinkingLevelChange("xhigh");
      await settle(); hook.flush();
      const switches = commands.filter((command) => command.type === "set_model").length;
      await hook.result.handleSend("first prompt"); hook.flush();
      assert.equal(commands.filter((command) => command.type === "set_model").length, switches);
      assert.deepEqual(prompts, [{ model: qwen, level: "xhigh" }]);
    } finally { hook.unmount(); }
  }
});

test("existing switches keep low visible through delayed model, effort and canonical history replies", async () => {
  const modelGate = Promise.withResolvers(), effortGate = Promise.withResolvers(), detailGate = Promise.withResolvers();
  const { hook, commands, serverLevel, writes } = await setup({
    existing: true, defaults: { [key(gpt)]: "medium", [key(qwen)]: "low" },
    staleDefaults: { [key(qwen)]: "medium" }, modelGate, thinkingGates: { low: effortGate }, detailGate,
  });
  const check = () => {
    hook.flush();
    assert.deepEqual(hook.result.displayModel, qwen);
    assert.equal(hook.result.thinkingLevel, "low");
    assert.equal(hook.result.savedDefaultThinkingLevel, "low");
    assert.equal(hook.result.modelSwitching, true);
  };
  try {
    assert.equal(hook.result.thinkingLevel, "medium");
    const switching = hook.result.handleModelChange(qwen.provider, qwen.modelId);
    check();
    await settle(); check();
    assert.equal(serverLevel(), "medium", "old SDK default is not the UI's target effort");
    modelGate.resolve(); await settle(); check();
    assert.equal(commands.at(-1).type, "set_thinking_level");
    effortGate.resolve(); await settle(); check();
    detailGate.resolve(); await switching; hook.flush();
    assert.equal(hook.result.modelSwitching, false);
    assert.equal(hook.result.thinkingLevel, "low");
    assert.equal(serverLevel(), "low");
    assert.deepEqual(writes, [], "optimistic display never persists settings");
  } finally { modelGate.resolve(); effortGate.resolve(); detailGate.resolve(); hook.unmount(); }
});

for (const canonicalFailure of [undefined, "http", "transport"]) {
  test(`pre-switch history cannot undo Qwen/low after canonical ${canonicalFailure ?? "success"}`, async () => {
    const backgroundReadGate = Promise.withResolvers();
    const { hook, emit } = await setup({
      existing: true, defaults: { [key(gpt)]: "medium", [key(qwen)]: "low" }, backgroundReadGate, canonicalFailure,
    });
    try {
      emit({ type: "agent_start" });
      emit({ type: "agent_end" });
      await settle(); hook.flush();
      let finished = false;
      const switching = hook.result.handleModelChange(qwen.provider, qwen.modelId).then(() => { finished = true; });
      await settle(); hook.flush();
      assert.equal(finished, true, "post-write reload must not join the gated pre-switch read");
      assert.deepEqual(hook.result.displayModel, qwen);
      assert.equal(hook.result.thinkingLevel, "low");
      if (canonicalFailure) assert.ok(hook.result.error, "failed validation stays visible rather than accepting stale history");
      backgroundReadGate.resolve(); await switching; await settle(); hook.flush();
      assert.deepEqual(hook.result.displayModel, qwen);
      assert.equal(hook.result.thinkingLevel, "low", "confirmed writes fence old medium even if the newer history read failed");
      if (canonicalFailure) assert.ok(hook.result.error);
    } finally { backgroundReadGate.resolve(); hook.unmount(); }
  });
}

test("optimistic switching uses each resolved target effort, including off, without hard-coding low", async () => {
  for (const preferred of ["xhigh", "off"]) {
    const modelGate = Promise.withResolvers();
    const { hook, serverLevel } = await setup({
      existing: true, defaults: { [key(gpt)]: "medium", [key(qwen)]: preferred },
      staleDefaults: { [key(qwen)]: "medium" }, modelGate,
    });
    try {
      const switching = hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
      assert.deepEqual(hook.result.displayModel, qwen);
      assert.equal(hook.result.thinkingLevel, preferred);
      await settle(); hook.flush();
      assert.equal(hook.result.thinkingLevel, preferred);
      modelGate.resolve(); await switching; hook.flush();
      assert.equal(hook.result.thinkingLevel, preferred);
      assert.equal(serverLevel(), preferred);
    } finally { modelGate.resolve(); hook.unmount(); }
  }
});

test("failed switches discard the optimistic effort and reconcile actual model and level", async () => {
  for (const failCommand of ["set_model", "set_thinking_level"]) {
    const { hook, serverLevel, writes } = await setup({
      existing: true, defaults: { [key(gpt)]: "medium", [key(qwen)]: "low" },
      staleDefaults: { [key(qwen)]: "medium" }, failCommand,
    });
    try {
      const switching = hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
      assert.equal(hook.result.thinkingLevel, "low");
      await switching; hook.flush();
      assert.equal(hook.result.modelSwitching, false);
      assert.deepEqual(hook.result.displayModel, failCommand === "set_model" ? gpt : qwen);
      assert.equal(hook.result.thinkingLevel, "medium", "show actual state, not the failed optimistic low");
      assert.equal(serverLevel(), "medium");
      assert.ok(hook.result.notices.some((notice) => notice.type === "error"));
      assert.deepEqual(writes, []);
    } finally { hook.unmount(); }
  }
});

test("later explicit effort wins over an existing model switch whose response is delayed", async () => {
  const modelGate = Promise.withResolvers();
  const explicitGate = Promise.withResolvers();
  const { hook, commands, serverLevel } = await setup({ existing: true, modelGate, thinkingGates: { xhigh: explicitGate } });
  try {
    const switching = hook.result.handleModelChange(qwen.provider, qwen.modelId);
    hook.flush();
    assert.equal(hook.result.thinkingLevel, "low", "target effort is displayed with the target model immediately");
    await settle(); hook.flush();
    const choosing = hook.result.handleThinkingLevelChange("xhigh"); hook.flush();
    assert.equal(hook.result.thinkingLevel, "xhigh");
    assert.equal(commands.filter((command) => command.type === "set_thinking_level").length, 0, "effort waits for the in-flight model response");
    modelGate.resolve(); await switching; await settle(); hook.flush();
    assert.equal(hook.result.thinkingLevel, "xhigh", "canonical reload and switch completion must not flash low before the later RPC replies");
    explicitGate.resolve(); await choosing; await settle(); hook.flush();
    assert.deepEqual(commands.filter((command) => command.type === "set_thinking_level").map((command) => command.level), ["low", "xhigh"]);
    assert.equal(serverLevel(), "xhigh");
    assert.equal(hook.result.thinkingLevel, "xhigh");
    assert.equal(hook.result.savedDefaultThinkingLevel, "low");
    assert.ok(!hook.result.notices.some((notice) => notice.type === "error"));
  } finally { modelGate.resolve(); explicitGate.resolve(); hook.unmount(); }
});

test("same-id reselect keeps an uninitialized draft and its temporary effort without creating a wrapper", async () => {
  const { hook, commands, creations, writes } = await setup();
  try {
    await hook.result.handleThinkingLevelChange("xhigh"); hook.flush();
    await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
    assert.equal(hook.result.thinkingLevel, "xhigh");
    assert.equal(hook.result.modelSwitching, false);
    assert.deepEqual(commands, []);
    assert.deepEqual(creations, []);
    assert.deepEqual(writes, []);
  } finally { hook.unmount(); }
});

test("reselecting an initialized automatic draft does not invent an explicit effort to carry across folders", async () => {
  const { hook, initialize, choices } = await setup({ reselectLevel: "off" });
  try {
    await initialize(); hook.flush();
    assert.equal(choices.at(-1).thinkingLevel, null);
    await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
    assert.equal(hook.result.thinkingLevel, "off");
    assert.equal(choices.at(-1).thinkingLevel, null, "native clamp updates this wrapper, not the user's draft overrides");
  } finally { hook.unmount(); }
});

for (const existing of [false, true]) {
  for (const reselectLevel of [undefined, "off"]) {
    test(`same-id refresh ${reselectLevel ? "adopts SDK clamp to off" : "preserves temporary effort"} (${existing ? "restored" : "initialized draft"})`, async () => {
      const { hook, commands, creations, writes, initialize, serverLevel, reads } = await setup({ existing, reselectLevel });
      try {
        if (!existing) { await initialize(); hook.flush(); }
        await hook.result.handleThinkingLevelChange("xhigh"); hook.flush();
        const start = commands.length, readStart = reads.length, creationCount = creations.length;
        await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
        assert.deepEqual(commands.slice(start), [{ type: "set_model", ...gpt }], "no default effort RPC: unchanged refresh adds no thinking entry");
        assert.equal(creations.length, creationCount);
        assert.equal(serverLevel(), reselectLevel ?? "xhigh");
        assert.equal(hook.result.thinkingLevel, reselectLevel ?? "xhigh");
        assert.equal(hook.result.savedDefaultThinkingLevel, "high", "reselect never changes this model's saved default");
        assert.equal(hook.result.modelSwitching, false);
        assert.ok(reads.slice(readStart).some((url) => url === "/api/sessions/model-defaults/state"));
        assert.ok(!reads.slice(readStart).some((url) => url.includes("force=1")), "canonical validation must not evict the wrapper");
        assert.deepEqual(writes, []);
      } finally { hook.unmount(); }
    });
  }
}

for (const existing of [false, true]) {
  test(`newer explicit effort wins through a delayed reselect and canonical read (${existing ? "restored" : "initialized draft"})`, async () => {
    const modelGate = Promise.withResolvers(), detailGate = Promise.withResolvers(), explicitGate = Promise.withResolvers();
    const { hook, commands, initialize, serverLevel } = await setup({ existing, modelGate, detailGate, thinkingGates: { low: explicitGate } });
    try {
      if (!existing) { await initialize(); hook.flush(); }
      const start = commands.length;
      const refreshing = hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
      assert.equal(hook.result.modelSwitching, true);
      await hook.result.handleModelChange(gpt.provider, gpt.modelId);
      const choosing = hook.result.handleThinkingLevelChange("low"); hook.flush();
      await hook.result.handleModelChange(qwen.provider, qwen.modelId);
      assert.equal(hook.result.thinkingLevel, "low");
      assert.deepEqual(commands.slice(start), [{ type: "set_model", ...gpt }], "rejected selections must not invalidate the explicit effort waiting on the flight");
      modelGate.resolve(); await settle(); hook.flush();
      assert.equal(hook.result.modelSwitching, true, "flight includes canonical validation");
      assert.equal(hook.result.thinkingLevel, "low");
      detailGate.resolve(); await refreshing; await settle(); hook.flush();
      assert.equal(hook.result.modelSwitching, false);
      assert.equal(hook.result.thinkingLevel, "low", "old canonical high must not flash while explicit low is unacknowledged");
      assert.deepEqual(commands.slice(start), [{ type: "set_model", ...gpt }, { type: "set_thinking_level", level: "low" }]);
      explicitGate.resolve(); await choosing; hook.flush();
      assert.equal(serverLevel(), "low");
      assert.equal(hook.result.thinkingLevel, "low");
    } finally { modelGate.resolve(); detailGate.resolve(); explicitGate.resolve(); hook.unmount(); }
  });
}

async function queuedClampScenario({ existing, hookImplementation, renderImplementation } = {}) {
  const modelGate = Promise.withResolvers(), detailGate = Promise.withResolvers(), explicitGate = Promise.withResolvers();
  const state = await setup({ existing, reselectLevel: "off", modelGate, detailGate,
    thinkingGates: { low: explicitGate }, hookImplementation, renderImplementation });
  const { hook, initialize, commands, serverLevel, choices, effortReads } = state;
  try {
    if (!existing) { await initialize(); hook.flush(); }
    const start = commands.length;
    const refreshing = hook.result.handleModelChange(gpt.provider, gpt.modelId);
    const choosing = hook.result.handleThinkingLevelChange("low"); hook.flush();
    assert.equal(hook.result.thinkingLevel, "low");
    modelGate.resolve(); await settle(); hook.flush();
    assert.equal(hook.result.thinkingLevel, "low", "canonical clamp must not hide the unacknowledged explicit pick");
    detailGate.resolve(); await refreshing; await settle(); hook.flush();
    assert.equal(serverLevel(), "off", "the actual effort write must clamp low too");
    assert.equal(hook.result.thinkingLevel, "low", "keep optimism until the effort acknowledgement");
    assert.deepEqual(commands.slice(start), [{ type: "set_model", ...gpt }, { type: "set_thinking_level", level: "low" }]);
    explicitGate.resolve(); await choosing; hook.flush();
    return { level: hook.result.thinkingLevel, native: serverLevel(), draftEffort: choices.at(-1)?.thinkingLevel, effortReads: effortReads.length };
  } finally { modelGate.resolve(); detailGate.resolve(); explicitGate.resolve(); hook.unmount(); }
}

for (const existing of [false, true]) {
  test(`queued low converges to SDK off after same-id capability refresh (${existing ? "restored" : "initialized draft"})`, async () => {
    const result = await queuedClampScenario({ existing });
    assert.equal(result.native, "off");
    assert.equal(result.level, "off");
    if (!existing) assert.equal(result.draftEffort, "off", "the draft's higher-priority explicit effort must also converge");
    assert.equal(result.effortReads, 1, "only the effort that waited for a model flight needs canonical confirmation");
  });
}

test("superseded effort picks waiting on the same flight never write or clear the newest pick", async () => {
  const modelGate = Promise.withResolvers();
  const { hook, commands, serverLevel } = await setup({ existing: true, reselectLevel: "off", modelGate });
  try {
    const refreshing = hook.result.handleModelChange(gpt.provider, gpt.modelId);
    const older = hook.result.handleThinkingLevelChange("low");
    const newer = hook.result.handleThinkingLevelChange("off"); hook.flush();
    assert.equal(hook.result.thinkingLevel, "off");
    modelGate.resolve(); await Promise.all([refreshing, older, newer]); hook.flush();
    assert.deepEqual(commands.filter((command) => command.type === "set_thinking_level"), [{ type: "set_thinking_level", level: "off" }]);
    assert.equal(hook.result.thinkingLevel, serverLevel());
  } finally { modelGate.resolve(); hook.unmount(); }
});

test("a queued effort confirmation cannot clear a newer unacknowledged effort on the same model", async () => {
  const modelGate = Promise.withResolvers(), effortReadGate = Promise.withResolvers(), explicitGate = Promise.withResolvers();
  const { hook, effortReads } = await setup({ existing: true, reselectLevel: "off", modelGate, effortReadGate, thinkingGates: { xhigh: explicitGate } });
  try {
    const refreshing = hook.result.handleModelChange(gpt.provider, gpt.modelId);
    const older = hook.result.handleThinkingLevelChange("low");
    modelGate.resolve(); await refreshing; await settle();
    assert.equal(effortReads.length, 1);
    const newer = hook.result.handleThinkingLevelChange("xhigh"); await settle(); hook.flush();
    assert.equal(hook.result.thinkingLevel, "xhigh");
    effortReadGate.resolve(); await older; hook.flush();
    assert.equal(hook.result.thinkingLevel, "xhigh", "changeId, not a newer write floor, protects the unacknowledged override");
    explicitGate.resolve(); await newer;
  } finally { modelGate.resolve(); effortReadGate.resolve(); explicitGate.resolve(); hook.unmount(); }
});

test("negative control: trusting the queued effort request leaves low despite the SDK's off clamp", async () => {
  const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const guard = "if (flight) {\n        // Reselect may have changed capabilities";
  assert.ok(source.includes(guard));
  const { useAgentSession: legacyHook, renderLegacyHook } = await jiti.evalModule(source.replace(guard, "if (false) {\n        // Reselect may have changed capabilities") + '\nexport { renderHook as renderLegacyHook } from "react";', {
    filename: fileURLToPath(new URL("./__negative-queued-clamp.ts", import.meta.url)), forceTranspile: true, async: true,
  });
  for (const existing of [false, true]) {
    const result = await queuedClampScenario({ existing, hookImplementation: legacyHook, renderImplementation: renderLegacyHook });
    assert.equal(result.native, "off");
    assert.equal(result.level, "low", "negative control demonstrates the original fictional effort");
    if (!existing) assert.equal(result.draftEffort, "low");
    assert.equal(result.effortReads, 0);
  }
});

for (const existing of [false, true]) {
  test(`a queued effort's delayed canonical read cannot clear a later model/explicit effort (${existing ? "restored" : "initialized draft"})`, async () => {
    const modelGate = Promise.withResolvers(), effortReadGate = Promise.withResolvers(), explicitGate = Promise.withResolvers();
    const { hook, initialize, effortReads } = await setup({ existing, modelGate, effortReadGate,
      reselectLevel: "off", thinkingGates: { xhigh: explicitGate } });
    try {
      if (!existing) { await initialize(); hook.flush(); }
      const refreshing = hook.result.handleModelChange(gpt.provider, gpt.modelId);
      const choosing = hook.result.handleThinkingLevelChange("low");
      modelGate.resolve(); await refreshing; await settle(); hook.flush();
      assert.equal(effortReads.length, 1);
      await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
      const newer = hook.result.handleThinkingLevelChange("xhigh"); await settle(); hook.flush();
      assert.equal(hook.result.thinkingLevel, "xhigh");
      effortReadGate.resolve(); await choosing; hook.flush();
      assert.deepEqual(hook.result.displayModel, qwen);
      assert.equal(hook.result.thinkingLevel, "xhigh", "older canonical off must not clear the newer optimistic override");
      explicitGate.resolve(); await newer; hook.flush();
      assert.equal(hook.result.thinkingLevel, "xhigh");
    } finally { modelGate.resolve(); effortReadGate.resolve(); explicitGate.resolve(); hook.unmount(); }
  });
}

async function selectionEpochScenario({ existing, hookImplementation, renderImplementation } = {}) {
  const modelGate = Promise.withResolvers(), secondAckGate = Promise.withResolvers(), effortReadGate = Promise.withResolvers();
  const { hook, initialize, effortReads, commands, choices } = await setup({ existing, modelGate,
    modelAckGates: { 2: secondAckGate }, effortReadGate, reselectLevel: "off", hookImplementation, renderImplementation });
  const snapshot = () => ({ model: hook.result.displayModel, level: hook.result.thinkingLevel,
    switching: hook.result.modelSwitching, choices: choices.at(-1) });
  try {
    if (!existing) { await initialize(); hook.flush(); }
    const start = commands.length;
    const refreshing = hook.result.handleModelChange(gpt.provider, gpt.modelId);
    const choosing = hook.result.handleThinkingLevelChange("low");
    modelGate.resolve(); await refreshing; await settle(); hook.flush();
    assert.equal(effortReads.length, 1, "A's effort GET must have captured the native clamp before B starts");
    assert.equal(effortReads[0].thinkingLevel, "off");
    assert.equal(hook.result.thinkingLevel, "low", "A's effort confirmation is still gated");

    let switchFinished = false;
    const switching = hook.result.handleModelChange(qwen.provider, qwen.modelId).then(() => { switchFinished = true; });
    await settle(); hook.flush();
    assert.equal(switchFinished, false, "the second set_model ACK, not just canonical history, must be gated");
    assert.deepEqual(commands.slice(start), [
      { type: "set_model", ...gpt }, { type: "set_thinking_level", level: "low" }, { type: "set_model", ...qwen },
    ], "B's default effort write must not have started before its model ACK");
    const beforeRead = snapshot();
    // No newer effort pick: changeId and the confirmed-write floor alone cannot
    // reject A's old off while B's selection has started but is unacknowledged.
    effortReadGate.resolve(); await choosing; hook.flush();
    assert.equal(switchFinished, false);
    const beforeAck = snapshot();
    secondAckGate.resolve(); await switching; await settle(); hook.flush();
    const afterAck = snapshot();
    assert.deepEqual(commands.slice(start).filter((command) => command.type === "set_thinking_level"), [
      { type: "set_thinking_level", level: "low" }, { type: "set_thinking_level", level: "low" },
    ], "only A's queued effort and B's resolved default are written; no new explicit effort hides the race");
    return { beforeRead, beforeAck, afterAck };
  } finally { modelGate.resolve(); secondAckGate.resolve(); effortReadGate.resolve(); hook.unmount(); }
}

for (const existing of [false, true]) {
  test(`selection epoch rejects A's effort GET while B's model ACK is pending (${existing ? "restored" : "initialized draft"})`, async () => {
    const { beforeRead, beforeAck, afterAck } = await selectionEpochScenario({ existing });
    for (const [phase, snapshot] of Object.entries({ beforeRead, beforeAck, afterAck })) {
      assert.deepEqual(snapshot.model, qwen, phase);
      assert.equal(snapshot.level, "low", `${phase}: B keeps its own resolved default`);
      assert.equal(snapshot.switching, phase !== "afterAck", phase);
      if (!existing) {
        assert.deepEqual(snapshot.choices.model, qwen, phase);
        assert.equal(snapshot.choices.thinkingLevel, null, `${phase}: A's clamp must never become B's explicit draft effort`);
      }
    }
  });
}

test("negative control: without the selection epoch A's effort GET poisons B before its model ACK", async () => {
  const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const guard = "\n      && modelSelectionEpochRef.current === selectionEpoch";
  assert.equal(source.split(guard).length, 2, "disable only the effort handler's new epoch check");
  const { useAgentSession: legacyHook, renderLegacyHook } = await jiti.evalModule(source.replace(guard, "") + '\nexport { renderHook as renderLegacyHook } from "react";', {
    filename: fileURLToPath(new URL("./__negative-selection-epoch.ts", import.meta.url)), forceTranspile: true, async: true,
  });
  for (const existing of [false, true]) {
    const { beforeRead, beforeAck, afterAck } = await selectionEpochScenario({ existing, hookImplementation: legacyHook, renderImplementation: renderLegacyHook });
    assert.equal(beforeRead.level, "low");
    assert.equal(beforeAck.level, "off", "old confirmation clears B's optimistic effort before its ACK");
    assert.equal(afterAck.level, existing ? "low" : "off", "initialized draft stays poisoned even after B succeeds");
    if (!existing) {
      for (const snapshot of [beforeAck, afterAck]) {
        assert.deepEqual(snapshot.choices.model, qwen);
        assert.equal(snapshot.choices.thinkingLevel, "off", "A's clamp was saved as B's explicit draft choice");
      }
    }
  }
});

for (const canonicalFailure of [undefined, "http", "transport"]) {
  test(`same-id confirmed-write floor rejects pre-reselect history after canonical ${canonicalFailure ?? "success"}`, async () => {
    const backgroundReadGate = Promise.withResolvers();
    const { hook, emit } = await setup({ existing: true, backgroundReadGate, canonicalFailure });
    try {
      emit({ type: "agent_start" }); emit({ type: "agent_end" });
      await settle(); hook.flush();
      await hook.result.handleThinkingLevelChange("xhigh"); hook.flush();
      let finished = false;
      const refreshing = hook.result.handleModelChange(gpt.provider, gpt.modelId).then(() => { finished = true; });
      await settle(); hook.flush();
      assert.equal(finished, true, "reselect must not join the gated pre-write history flight");
      assert.equal(hook.result.thinkingLevel, "xhigh");
      backgroundReadGate.resolve(); await refreshing; await settle(); hook.flush();
      assert.equal(hook.result.thinkingLevel, "xhigh");
      assert.equal(hook.result.modelSwitching, false);
      if (canonicalFailure) assert.ok(hook.result.error, "a failed canonical read is not a silent success");
    } finally { backgroundReadGate.resolve(); hook.unmount(); }
  });
}

test("negative control: the old same-id guard swallows live refresh entirely", async () => {
  const source = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const guard = "if (displayModelRef.current?.provider === provider && displayModelRef.current?.modelId === modelId) {";
  assert.ok(source.includes(guard));
  const { useAgentSession: legacyHook, renderLegacyHook } = await jiti.evalModule(source.replace(guard, `${guard}\n      return; // Restore the old same-id no-op.`) + '\nexport { renderHook as renderLegacyHook } from "react";', {
    filename: fileURLToPath(new URL("./__negative-reselect-guard.ts", import.meta.url)), forceTranspile: true, async: true,
  });
  const { hook, commands, serverLevel } = await setup({ existing: true, reselectLevel: "off", hookImplementation: legacyHook, renderImplementation: renderLegacyHook });
  try {
    const start = commands.length;
    await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
    assert.deepEqual(commands.slice(start), [], "negative control never reaches backend refresh");
    assert.equal(serverLevel(), "high", "therefore the edited definition's native off clamp never arrives");
  } finally { hook.unmount(); }
});

test("same-run settled history and a newer explicit effort do not discard agent_end's full prompt/extensions", async () => {
  const agentReadGate = Promise.withResolvers();
  const agentFullState = { systemPrompt: "finished prompt", extensionStatuses: [{ key: "done", text: "finished" }],
    extensionWidgets: [{ key: "done", lines: ["finished"] }] };
  const { hook, emit, reads } = await setup({ existing: true, agentReadGate, agentFullState });
  const historyCount = () => reads.filter((url) => url.startsWith("/api/sessions/model-defaults?")).length;
  try {
    const before = historyCount();
    emit({ type: "agent_start" }); emit({ type: "agent_end" }); await settle(); hook.flush();
    assert.equal(historyCount(), before + 1, "agent_end's H finished while full-state F is gated");
    await hook.result.handleThinkingLevelChange("low"); hook.flush();
    emit({ type: "agent_settled" }); await settle(); hook.flush();
    assert.equal(historyCount(), before + 2, "settlement's newer H2 finished on the same logical run");
    assert.equal(hook.result.thinkingLevel, "low");
    assert.equal(hook.result.systemPrompt, null);
    agentReadGate.resolve(); await settle(); hook.flush();
    assert.equal(hook.result.systemPrompt, "finished prompt");
    assert.deepEqual(hook.result.extensionStatuses, agentFullState.extensionStatuses);
    assert.deepEqual(hook.result.extensionWidgets, agentFullState.extensionWidgets);
    assert.equal(hook.result.thinkingLevel, "low", "F's old high must not undo the acknowledged explicit effort");
  } finally { agentReadGate.resolve(); hook.unmount(); }
});

for (const lostModelReply of [false, true]) {
  test(`an old agent_end full-state reply cannot undo a reselect's confirmed SDK clamp (${lostModelReply ? "lost ack" : "acknowledged"})`, async () => {
    const agentReadGate = Promise.withResolvers();
    const { hook, emit } = await setup({ existing: true, agentReadGate, reselectLevel: "off", lostModelReply });
    try {
      emit({ type: "agent_start" }); emit({ type: "agent_end" });
      await settle(); hook.flush();
      await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
      assert.equal(hook.result.thinkingLevel, "off");
      agentReadGate.resolve(); await settle(); hook.flush();
      assert.equal(hook.result.thinkingLevel, "off");
    } finally { agentReadGate.resolve(); hook.unmount(); }
  });
}

test("an old state reply cannot undo a reselect's confirmed SDK clamp", async () => {
  const backgroundStateGate = Promise.withResolvers();
  const { hook } = await setup({ existing: true, backgroundStateGate, reselectLevel: "off" });
  try {
    await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
    assert.equal(hook.result.thinkingLevel, "off");
    backgroundStateGate.resolve(); await settle(); hook.flush();
    assert.equal(hook.result.thinkingLevel, "off");
  } finally { backgroundStateGate.resolve(); hook.unmount(); }
});

for (const lostModelReply of [false, true]) {
  for (const existing of [false, true]) {
    test(`failed same-id refresh reconciles actual effort (${existing ? "restored" : "initialized draft"}, ${lostModelReply ? "lost ack after clamp" : "refused"})`, async () => {
      const { hook, initialize, commands, serverLevel } = await setup({
        existing, lostModelReply, failCommand: lostModelReply ? undefined : "set_model", reselectLevel: "off",
      });
      try {
        if (!existing) { await initialize(); hook.flush(); }
        await hook.result.handleThinkingLevelChange("xhigh"); hook.flush();
        const start = commands.length;
        await hook.result.handleModelChange(gpt.provider, gpt.modelId); hook.flush();
        assert.equal(hook.result.modelSwitching, false);
        assert.equal(hook.result.thinkingLevel, lostModelReply ? "off" : "xhigh");
        assert.equal(hook.result.thinkingLevel, serverLevel());
        assert.deepEqual(commands.slice(start), [{ type: "set_model", ...gpt }]);
        assert.ok(hook.result.notices.some((notice) => notice.type === "error"));
      } finally { hook.unmount(); }
    });
  }
}

for (const existing of [false, true]) {
  test(`a failed reselect cancels its waiting effort RPC and reconciles the actual clamp (${existing ? "restored" : "initialized draft"})`, async () => {
    const modelGate = Promise.withResolvers();
    const { hook, initialize, commands } = await setup({ existing, lostModelReply: true, reselectLevel: "off", modelGate });
    try {
      if (!existing) { await initialize(); hook.flush(); }
      const start = commands.length;
      const refreshing = hook.result.handleModelChange(gpt.provider, gpt.modelId);
      const choosing = hook.result.handleThinkingLevelChange("low"); hook.flush();
      assert.equal(hook.result.thinkingLevel, "low");
      modelGate.resolve(); await Promise.all([refreshing, choosing]); hook.flush();
      assert.equal(hook.result.thinkingLevel, "off", "a cancelled low RPC must not leave low on screen");
      assert.equal(hook.result.modelSwitching, false);
      assert.deepEqual(commands.slice(start), [{ type: "set_model", ...gpt }]);
      assert.ok(hook.result.notices.some((notice) => notice.type === "error"));
    } finally { modelGate.resolve(); hook.unmount(); }
  });
}

test("a model switch during creation owns the displayed effort and completes before the pending first prompt", async () => {
  for (const prompting of [false, true]) {
    const creationGate = Promise.withResolvers();
    const { hook, initialize, prompts, serverLevel } = await setup({ creationGate });
    try {
      const starting = prompting ? hook.result.handleSend("first prompt") : initialize();
      await settle(); hook.flush();
      const switching = hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
      assert.equal(hook.result.thinkingLevel, "low");
      creationGate.resolve();
      await Promise.all([starting, switching]); await settle(); hook.flush();
      assert.equal(hook.result.displayModel.modelId, qwen.modelId);
      assert.equal(hook.result.thinkingLevel, "low", "A's late creation response must not overwrite B's effort");
      assert.equal(serverLevel(), "low");
      if (prompting) assert.deepEqual(prompts, [{ model: qwen, level: "low" }]);
    } finally { hook.unmount(); }
  }
});
