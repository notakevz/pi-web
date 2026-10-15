import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url);
const preferences = await jiti.import("./default-preferences.ts");
const modelScope = await jiti.import("./model-scope.ts");
const modelsCache = await jiti.import("./models-cache.ts");
const thinkingControls = await jiti.import("./thinking-controls.ts");

// Execute the actual route bodies with only their external service/IO boundaries
// replaced. No ModelRuntime, auth storage, extensions or real agent dir is opened.
async function loadRoute(relativePath, dependencies) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function("require", "exports", outputText)((name) => {
    if (!(name in dependencies)) throw new Error(`Unmocked route import: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

function model(provider, id = "same", off = "none") {
  return {
    provider, id, name: `${provider} ${id}`, api: "openai-completions", reasoning: true,
    input: ["text"], contextWindow: 1000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { off, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
  };
}

async function withRoutes(run, { global = {}, project, models = [model("a"), model("b")], corruptGlobal, corruptProject, writeFailure, serviceFailure } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-model-default-route-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const settingsPath = path.join(agentDir, "settings.json");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(settingsPath, corruptGlobal ?? JSON.stringify(global));
  if (project || corruptProject) {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi", "settings.json"), corruptProject ?? JSON.stringify(project));
  }
  const state = { serviceLoads: 0, denied: false };
  const dependencies = {
    fs, "fs/promises": fsPromises, path,
    "@earendil-works/pi-ai": piAi,
    "@earendil-works/pi-coding-agent": {
      getAgentDir: () => agentDir,
      createAgentSessionServices: async () => {
        state.serviceLoads += 1;
        if (serviceFailure) throw new Error("sensitive SDK load details");
        const settingsManager = writeFailure
          ? SettingsManager.fromStorage({ withLock(scope, fn) {
            const next = fn(scope === "global" ? JSON.stringify(global) : undefined);
            if (next !== undefined) throw new Error("settings write failed");
          } })
          : SettingsManager.create(cwd, agentDir);
        return {
          settingsManager,
          modelRuntime: { getAvailable: async () => models, getError: () => undefined },
        };
      },
    },
    "@/lib/default-preferences": preferences,
    "@/lib/model-scope": modelScope,
    "@/lib/models-cache": modelsCache,
    "@/lib/thinking-controls": thinkingControls,
    "@/lib/deferred-provider-models": { withDeferredProviderModels: (runtime) => runtime, rememberProviderModels: async () => {} },
    "@/lib/file-access": { getAllowedFileRoots: async () => [root], isExistingFilePathAllowed: () => !state.denied },
    "@/lib/project-trust": { projectTrustReloadOptions: () => undefined },
    "@/lib/worktree": { inferRemovedWorktree: () => null },
  };
  const { PUT } = await loadRoute("../app/api/models/default/route.ts", dependencies);
  const { GET } = await loadRoute("../app/api/models/route.ts", dependencies);
  const put = (body) => PUT(new Request("http://localhost/api/models/default", {
    method: "PUT", body: JSON.stringify({ cwd, ...body }),
  }));
  const get = () => GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(cwd)}`));
  modelsCache.invalidateModelsCache();
  try {
    await run({ put, get, PUT, cwd, settingsPath, state });
  } finally {
    modelsCache.invalidateModelsCache();
    await rm(root, { recursive: true, force: true });
  }
}

const perModel = (provider = "a", level = "off", modelId = "same") => ({
  modelThinkingLevel: { provider, modelId, level },
});

test("PUT saves an isolated exact per-model default and GET returns the effective merged map", async () => {
  const global = {
    defaultProvider: "a", defaultModel: "same", defaultThinkingLevel: "medium",
    modelThinkingLevels: { "a/same": "high", "b/same": "low", "hidden/model": "max" },
    theme: "dark",
  };
  await withRoutes(async ({ put, get, settingsPath }) => {
    const before = await (await get()).json();
    assert.equal(before.savedDefaultThinkingLevel, "medium");
    assert.equal(before.defaultThinkingLevel, "high");
    assert.deepEqual(before.modelThinkingDefaults, { ...global.modelThinkingLevels, "project/only": "off" });
    const response = await put(perModel());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ...perModel() });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      ...global, modelThinkingLevels: { ...global.modelThinkingLevels, "a/same": "off" },
    });
    const after = await (await get()).json();
    assert.equal(after.defaultThinkingLevel, "off");
    assert.equal(after.savedDefaultThinkingLevel, "medium");
    assert.equal(after.modelThinkingDefaults["b/same"], "low");
  }, { global, project: { modelThinkingLevels: { "project/only": "off" } } });
});

test("PUT rejects only matching project model keys, not project global defaults or other model keys", async () => {
  await withRoutes(async ({ put }) => {
    const response = await put(perModel());
    assert.equal(response.status, 200);
  }, { project: { defaultProvider: "project", defaultModel: "model", defaultThinkingLevel: "high", modelThinkingLevels: { "b/same": "low" } } });
  await withRoutes(async ({ put, settingsPath }) => {
    const before = await readFile(settingsPath, "utf8");
    const response = await put(perModel());
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.reason, "project-scope");
    assert.deepEqual(body.keys, ["modelThinkingLevels.a/same"]);
    assert.equal(await readFile(settingsPath, "utf8"), before);
  }, { project: { modelThinkingLevels: { "a/same": "high" } } });
});

test("GET keeps the raw global fallback separate from project thinking and per-model defaults", async () => {
  await withRoutes(async ({ get }) => {
    const data = await (await get()).json();
    assert.equal(data.savedDefaultThinkingLevel, "medium");
    assert.equal(data.defaultThinkingLevel, "high");
    assert.equal(data.fallbackThinkingLevel, "high", "project fallback stays separate from the raw global setting");
    assert.deepEqual(data.modelThinkingDefaults, { "b/same": "off" });
  }, {
    global: { defaultProvider: "a", defaultModel: "same", defaultThinkingLevel: "medium" },
    project: { defaultThinkingLevel: "high", modelThinkingLevels: { "b/same": "off" } },
  });
});

test("scope thinking pins outrank per-model defaults at startup and conflicting saves return 409", async () => {
  await withRoutes(async ({ put, get, settingsPath }) => {
    const before = await readFile(settingsPath, "utf8");
    const data = await (await get()).json();
    assert.equal(data.defaultThinkingLevel, "high");
    assert.equal(data.savedDefaultThinkingLevel, "medium");
    assert.equal(data.modelThinkingDefaults["a/same"], "low");
    assert.equal(data.thinkingLevelPins["a/same"], "high");
    const conflict = await put(perModel());
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).reason, "thinking-level-pin");
    assert.equal(await readFile(settingsPath, "utf8"), before);
    assert.equal((await put(perModel("a", "high"))).status, 200);
  }, { global: { defaultProvider: "a", defaultModel: "same", defaultThinkingLevel: "medium", enabledModels: ["a/same:high"], modelThinkingLevels: { "a/same": "low" } } });
});

test("PUT requires an exact visible target and an SDK-supported level (off:null is unsupported)", async () => {
  await withRoutes(async ({ put }) => {
    assert.equal((await put(perModel("b"))).status, 404);
    assert.equal((await put(perModel("missing"))).status, 404);
    assert.equal((await put(perModel("a", "xhigh"))).status, 400);
    assert.equal((await put(perModel("a", "off"))).status, 400);
    assert.equal((await put(perModel("a", "low"))).status, 200);
  }, { models: [model("a", "same", null), model("b")], global: { enabledModels: ["a/same"] } });
});

test("legacy model/global thinking edits still work without modifying per-model defaults", async () => {
  await withRoutes(async ({ put, settingsPath }) => {
    const response = await put({ provider: "b", modelId: "same", thinkingLevel: "off" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, defaultModel: { provider: "b", modelId: "same" }, defaultThinkingLevel: "off" });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      defaultProvider: "b", defaultModel: "same", defaultThinkingLevel: "off", modelThinkingLevels: { "a/same": "high" },
    });
  }, { global: { modelThinkingLevels: { "a/same": "high" } } });
});

test("PUT malformed, incomplete and mixed edits fail before loading any services", async () => {
  await withRoutes(async ({ PUT, put, state }) => {
    for (const body of [null, [], "high", {}, { provider: "a" }, { modelThinkingLevel: { provider: "a", level: "off" } }, { ...perModel(), thinkingLevel: "off" }, { ...perModel(), provider: "a", modelId: "same" }]) {
      const response = await PUT(new Request("http://localhost/api/models/default", { method: "PUT", body: JSON.stringify(body) }));
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal((await PUT(new Request("http://localhost/api/models/default", { method: "PUT", body: "{ not json" }))).status, 400);
    assert.equal(state.serviceLoads, 0);
    state.denied = true;
    assert.equal((await put(perModel())).status, 403);
    assert.equal(state.serviceLoads, 0);
  });
});

test("PUT surfaces settings load/write failures without pretending persistence succeeded", async () => {
  for (const options of [{ corruptGlobal: "{ broken" }, { corruptProject: "{ broken" }, { writeFailure: true }]) {
    await withRoutes(async ({ put, settingsPath }) => {
      const before = await readFile(settingsPath, "utf8");
      assert.equal((await put(perModel())).status, 500);
      assert.equal(await readFile(settingsPath, "utf8"), before);
    }, options);
  }
});

test("GET safe load failure includes an empty per-model map without disclosing SDK error details", async () => {
  await withRoutes(async ({ get }) => {
    const response = await get();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.modelThinkingDefaults, {});
    assert.equal(body.savedDefaultThinkingLevel, null);
    assert.equal(body.defaultThinkingLevel, null);
    assert.equal(body.modelError, "Model list is temporarily unavailable. Check your configuration and try again.");
  }, { serviceFailure: true });
});
