import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { isThinkingLevel, parseDefaultPreferencesEdit, shadowingProjectKeys, writeDefaultPreferences } = await createJiti(import.meta.url)
  .import("./default-preferences.ts");

async function withSettings(run, { project, global } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-default-preferences-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  if (global) await writeFile(join(agentDir, "settings.json"), JSON.stringify(global));
  if (project) {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(project));
  }

  try {
    const settings = SettingsManager.create(cwd, agentDir);
    await run({ settings, settingsPath: join(agentDir, "settings.json"), cwd, agentDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("writes the saved default model without touching the thinking default", async () => {
  await withSettings(async ({ settings, settingsPath }) => {
    settings.setDefaultThinkingLevel("medium");
    await settings.flush();

    await writeDefaultPreferences(settings, { model: { provider: "deepseek", modelId: "deepseek-chat" } });

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultProvider, "deepseek");
    assert.equal(saved.defaultModel, "deepseek-chat");
    assert.equal(saved.defaultThinkingLevel, "medium");
  });
});

test("writes the saved default thinking level without touching the model default", async () => {
  await withSettings(async ({ settings, settingsPath }) => {
    settings.setDefaultModelAndProvider("saved", "saved-model");
    await settings.flush();

    await writeDefaultPreferences(settings, { thinkingLevel: "high" });

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultProvider, "saved");
    assert.equal(saved.defaultModel, "saved-model");
    assert.equal(saved.defaultThinkingLevel, "high");
  });
});

test("refuses to write when the global settings file could not be loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-default-preferences-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), "{ not json");
    const settings = SettingsManager.create(root, agentDir);

    await assert.rejects(writeDefaultPreferences(settings, { thinkingLevel: "high" }));
    assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), "{ not json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports project keys that would hide the edited global default", async () => {
  await withSettings(async ({ settings }) => {
    assert.deepEqual(
      shadowingProjectKeys(settings, { model: { provider: "a", modelId: "b" }, thinkingLevel: "low" }),
      ["defaultModel", "defaultThinkingLevel"],
    );
    // A project value for a field this edit does not write is irrelevant.
    assert.deepEqual(shadowingProjectKeys(settings, { model: { provider: "a", modelId: "b" } }), ["defaultModel"]);
  }, { project: { defaultModel: "project-model", defaultThinkingLevel: "off" } });

  await withSettings(async ({ settings }) => {
    assert.deepEqual(shadowingProjectKeys(settings, { thinkingLevel: "low" }), []);
  }, { project: { defaultProvider: "p" } });
});

test("per-model defaults isolate providers with identical IDs, preserve other entries and global defaults, and persist off", async () => {
  const global = {
    defaultProvider: "saved", defaultModel: "saved-model", defaultThinkingLevel: "medium",
    modelThinkingLevels: { "a/same": "high", "b/same": "low", "other/nested/id": "max" },
    theme: "dark", compaction: { enabled: false },
  };
  await withSettings(async ({ settings, settingsPath, cwd, agentDir }) => {
    await writeDefaultPreferences(settings, { modelThinkingLevel: { provider: "a", modelId: "same", level: "off" } }, settingsPath);
    const expected = { ...global, modelThinkingLevels: { ...global.modelThinkingLevels, "a/same": "off" } };
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), expected);
    const restored = SettingsManager.create(cwd, agentDir);
    assert.equal(restored.getModelThinkingLevel("a", "same"), "off");
    assert.equal(restored.getModelThinkingLevel("b", "same"), "low");
    assert.equal(restored.getDefaultThinkingLevel(), "medium");
  }, { global });
});

test("serializes concurrent web per-model saves and reloads stale SDK managers", async () => {
  await withSettings(async ({ settings, settingsPath, cwd, agentDir }) => {
    const other = SettingsManager.create(cwd, agentDir);
    await Promise.all([
      writeDefaultPreferences(settings, { modelThinkingLevel: { provider: "a", modelId: "same", level: "off" } }, settingsPath),
      writeDefaultPreferences(other, { modelThinkingLevel: { provider: "b", modelId: "same", level: "high" } }, settingsPath),
    ]);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      defaultThinkingLevel: "medium", modelThinkingLevels: { "a/same": "off", "b/same": "high" },
    });
  }, { global: { defaultThinkingLevel: "medium" } });
});

test("only the exact project per-model key shadows a per-model edit", async () => {
  const edit = { modelThinkingLevel: { provider: "a", modelId: "nested/id", level: "off" } };
  await withSettings(async ({ settings }) => {
    assert.deepEqual(shadowingProjectKeys(settings, edit), []);
  }, { project: {
    defaultProvider: "project", defaultModel: "project", defaultThinkingLevel: "high",
    modelThinkingLevels: { "b/nested/id": "low", "a/other": "medium" },
  } });
  for (const level of ["off", "high", null]) {
    await withSettings(async ({ settings }) => {
      assert.deepEqual(shadowingProjectKeys(settings, edit), ["modelThinkingLevels.a/nested/id"]);
    }, { project: { modelThinkingLevels: { "a/nested/id": level } } });
  }
});

test("effective per-model maps merge project keys without leaking them into global persistence", async () => {
  await withSettings(async ({ settings, settingsPath }) => {
    assert.deepEqual(settings.getAllModelThinkingLevels(), { "a/same": "off", "b/same": "low", "project/only": "max" });
    await writeDefaultPreferences(settings, { modelThinkingLevel: { provider: "b", modelId: "same", level: "high" } }, settingsPath);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      defaultThinkingLevel: "medium", modelThinkingLevels: { "a/same": "high", "b/same": "high" },
    });
  }, {
    global: { defaultThinkingLevel: "medium", modelThinkingLevels: { "a/same": "high", "b/same": "low" } },
    project: { modelThinkingLevels: { "a/same": "off", "project/only": "max" } },
  });
});

test("reports native SDK load and queued write failures for per-model edits", async () => {
  const edit = { modelThinkingLevel: { provider: "a", modelId: "same", level: "off" } };
  for (const failureScope of ["global", "project"]) {
    const manager = SettingsManager.fromStorage({ withLock(scope, fn) {
      if (scope === failureScope) throw new Error(`${scope} load failed`);
      fn(undefined);
    } });
    await assert.rejects(writeDefaultPreferences(manager, edit), new RegExp(`${failureScope} load failed`));
  }
  let fail = false;
  const manager = SettingsManager.fromStorage({ withLock(scope, fn) {
    if (fail && scope === "global") throw new Error("write failed");
    fn(undefined);
  } });
  fail = true;
  await assert.rejects(writeDefaultPreferences(manager, edit), /write failed/);
  assert.deepEqual(manager.drainErrors(), []);
});

test("parses legacy edits and a separate per-model edit", () => {
  assert.deepEqual(parseDefaultPreferencesEdit({ provider: "a", modelId: "same", thinkingLevel: "high" }), {
    model: { provider: "a", modelId: "same" }, thinkingLevel: "high",
  });
  assert.deepEqual(parseDefaultPreferencesEdit({ thinkingLevel: "off" }), { thinkingLevel: "off" });
  assert.deepEqual(parseDefaultPreferencesEdit({ cwd: "/project", modelThinkingLevel: { provider: "a", modelId: "nested/id", level: "off" } }), {
    modelThinkingLevel: { provider: "a", modelId: "nested/id", level: "off" },
  });
});

test("rejects malformed, incomplete and ambiguous mixed requests", () => {
  const target = { provider: "a", modelId: "same", level: "off" };
  for (const body of [
    null, [], "high", {}, { cwd: "/only" }, { provider: "a" }, { modelId: "same" },
    { provider: " ", modelId: "same" }, { thinkingLevel: "auto" }, { thinkingLevel: null },
    { modelThinkingLevel: null }, { modelThinkingLevel: [] }, { modelThinkingLevel: "high" },
    { modelThinkingLevel: { provider: "a", modelId: "same" } },
    { modelThinkingLevel: { provider: "a", level: "high" } },
    { modelThinkingLevel: { modelId: "same", level: "high" } },
    { modelThinkingLevel: { ...target, level: "auto" } },
    { modelThinkingLevel: { ...target, provider: "" } },
    { modelThinkingLevel: { ...target, modelId: 12 } },
    { modelThinkingLevel: { ...target, extra: true } },
    { modelThinkingLevel: target, provider: "a", modelId: "same" },
    { modelThinkingLevel: target, provider: "a" },
    { modelThinkingLevel: target, thinkingLevel: "off" },
    { modelThinkingLevel: target, cwd: 12 },
    { modelThinkingLevel: target, cwd: " " },
    { modelThinkingLevel: target, defaultThinkingLevel: "off" },
  ]) assert.equal(parseDefaultPreferencesEdit(body), null, JSON.stringify(body));
});

test("accepts only pi thinking levels", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(isThinkingLevel(level), true);
  }
  assert.equal(isThinkingLevel("auto"), false);
  assert.equal(isThinkingLevel(undefined), false);
});
