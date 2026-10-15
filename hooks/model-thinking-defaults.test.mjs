import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

async function setup({ existing = false, defaults = { [key(gpt)]: "high", [key(qwen)]: "low" }, pins = {}, saveGate, saveError, fallback = "medium", creationGate, modelGate, thinkingGates = {}, detailGate, failCommand, staleDefaults, backgroundReadGate, canonicalFailure } = {}) {
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
  const writes = [], commands = [], creations = [], prompts = [];
  let serverModel = gpt, serverLevel = defaults[key(gpt)] ?? "medium";
  let sessionTools = null;
  // Deliberately stale SDK settings: a live wrapper does not learn star writes by itself.
  const wrapperDefaults = { ...defaults, ...staleDefaults };
  const preferences = new Map([["pi-tool-preset", "full"]]);
  window.localStorage = { getItem: (k) => preferences.get(k) ?? null, setItem: (k, v) => preferences.set(k, v) };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
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
    if (url === "/api/sessions/model-defaults/state") return Response.json({
      running: false, state: { model: { provider: serverModel.provider, id: serverModel.modelId }, thinkingLevel: serverLevel },
    });
    if (url === "/api/agent/model-defaults" && body) {
      commands.push(body);
      if (body.type === failCommand) throw new Error(`fixture failure: ${failCommand}`);
      let data = {};
      if (body.type === "set_model") {
        serverModel = { provider: body.provider, modelId: body.modelId };
        serverLevel = wrapperDefaults[key(serverModel)] ?? fallback ?? serverLevel;
        data = { provider: body.provider, id: body.modelId };
        if (modelGate) await modelGate.promise;
      }
      if (body.type === "set_thinking_level") {
        serverLevel = body.level; data = null;
        if (thinkingGates[body.level]) await thinkingGates[body.level].promise;
      }
      if (body.type === "prompt") prompts.push({ model: serverModel, level: serverLevel });
      if (body.type === "get_state") data = { model: { ...serverModel, id: serverModel.modelId }, thinkingLevel: serverLevel };
      if (body.type === "get_tools") data = (sessionTools ?? ["read", "bash", "edit", "write"]).map((name) => ({ name, active: true }));
      return Response.json({ success: true, data });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const props = existing ? { session: { id: "model-defaults", cwd: "/project" } }
    : { session: null, newSessionCwd: "/project", newSessionDraftKey: "new:defaults" };
  let systemInfoLoader;
  const hook = renderHook(useAgentSession, { ...props, onSystemInfoLoaderChange: (loader) => { systemInfoLoader = loader; } });
  await settle(); hook.flush();
  const events = globalThis.EventSource.latest;
  return { hook, writes, commands, creations, preferences, prompts, initialize: () => systemInfoLoader(), catalog: () => catalog, serverLevel: () => serverLevel,
    emit: (event) => events.onmessage({ data: JSON.stringify(event) }) };
}

test("fresh chats resolve the default model's effort; model switches use each model's own star", async () => {
  const { hook, writes } = await setup();
  try {
    assert.equal(hook.result.toolPreset, "full");
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

test("starting a fresh chat sends its selected model and full tools, without turning resolved effort into an override", async () => {
  const { hook, creations, serverLevel, initialize } = await setup();
  try {
    await hook.result.handleModelChange(qwen.provider, qwen.modelId); hook.flush();
    await initialize(); hook.flush();
    assert.deepEqual(creations[0].toolNames, ["bash", "read", "edit", "write", "grep", "find", "ls"]);
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

test("tool changes affect this chat only; remounting a fresh chat starts in full", async () => {
  const { hook, preferences, writes } = await setup();
  try {
    await hook.result.handleToolPresetChange("default"); hook.flush();
    assert.equal(hook.result.toolPreset, "default");
    assert.equal(preferences.get("pi-tool-preset"), "full", "legacy browser data is neither read nor rewritten");
    assert.deepEqual(writes, []);
  } finally { hook.unmount(); }
  const fresh = await setup();
  try { assert.equal(fresh.hook.result.toolPreset, "full"); }
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
