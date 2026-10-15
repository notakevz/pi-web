import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CONCRETE_TOOL_PRESET_VALUES,
  CONFIGURED_TOOL_PRESET,
  DEFAULT_TOOL_PRESET,
  NEW_SESSION_TOOL_PRESET,
  TOOL_MODE_PRESETS,
  getToolModeLabel,
  TOOL_PRESET_VALUES,
  PRESET_DEFAULT,
  PRESET_FULL,
  PRESET_NONE,
  PRESET_READ_ONLY,
  getPresetFromToolNames,
  getPresetFromTools,
  getToolNamesForPreset,
  isConcreteToolPreset,
  isToolPreset,
} = await jiti.import("./tool-presets.ts");

const BUILTIN_NAMES = ["bash", "powershell", "read", "edit", "write", "grep", "find", "ls"];

function toolEntries(activeNames, customNames = []) {
  const active = new Set(activeNames);
  return [...BUILTIN_NAMES, ...customNames].map((name) => ({
    name,
    description: name,
    active: active.has(name),
  }));
}

test("maps every tool preset to its built-in tools", () => {
  assert.deepEqual(getToolNamesForPreset("none"), PRESET_NONE);
  assert.deepEqual(getToolNamesForPreset("read-only"), PRESET_READ_ONLY);
  assert.deepEqual(getToolNamesForPreset("default"), PRESET_DEFAULT);
  assert.deepEqual(getToolNamesForPreset("full"), PRESET_FULL);
  assert.deepEqual(PRESET_READ_ONLY, ["read", "grep", "find", "ls"]);
});

test("recognizes presets while ignoring active custom tools", () => {
  const customNames = ["web_search", "delegate"];

  assert.equal(getPresetFromTools(toolEntries([], customNames)), "none");
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_READ_ONLY, ...customNames], customNames)),
    "read-only",
  );
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_DEFAULT, ...customNames], customNames)),
    "default",
  );
  assert.equal(
    getPresetFromTools(toolEntries([...PRESET_FULL, ...customNames], customNames)),
    "full",
  );
});

test("returns fresh tool arrays that callers can safely modify", () => {
  const names = getToolNamesForPreset("read-only");
  names.push("custom");
  assert.deepEqual(getToolNamesForPreset("read-only"), PRESET_READ_ONLY);
});

test("recognizes PowerShell as the shell in standard presets", () => {
  assert.equal(
    getPresetFromTools(toolEntries(["read", "powershell", "edit", "write"])),
    "default",
  );
  assert.equal(
    getPresetFromTools(toolEntries(["powershell", "read", "edit", "write", "grep", "find", "ls"])),
    "full",
  );
});

test("full stays full when the live SDK loadout activates both shells", () => {
  const names = [...PRESET_FULL, "powershell", "subagent", "webfetch", "codemode"];
  assert.equal(getPresetFromToolNames(names), "full");
  assert.equal(getPresetFromTools(toolEntries(names, ["subagent", "webfetch", "codemode"])), "full");
});

test("the legacy configured preset stands for \"no explicit override\"", () => {
  // Only the legacy sentinel omits toolNames; build must never do so.
  assert.equal(getToolNamesForPreset(CONFIGURED_TOOL_PRESET), undefined);
  assert.equal(CONFIGURED_TOOL_PRESET, "configured");

  assert.ok(isToolPreset(CONFIGURED_TOOL_PRESET));
  assert.ok(!isConcreteToolPreset(CONFIGURED_TOOL_PRESET));
  assert.deepEqual(
    TOOL_PRESET_VALUES.filter((preset) => !CONCRETE_TOOL_PRESET_VALUES.includes(preset)),
    [CONFIGURED_TOOL_PRESET],
  );

  // Every concrete preset still resolves to a real tool list.
  for (const preset of CONCRETE_TOOL_PRESET_VALUES) {
    assert.ok(Array.isArray(getToolNamesForPreset(preset)), preset);
  }
});

test("plan/build/full retain wire IDs and build sends exactly four built-ins", () => {
  assert.deepEqual(TOOL_MODE_PRESETS, { plan: "read-only", build: "default", full: "full" });
  assert.equal(DEFAULT_TOOL_PRESET, "default");
  assert.deepEqual(getToolNamesForPreset(DEFAULT_TOOL_PRESET), ["read", "bash", "edit", "write"]);
  assert.equal(getToolModeLabel("read-only"), "plan");
  assert.equal(getToolModeLabel("default"), "build");
  assert.equal(getToolModeLabel("full"), "full");
  for (const legacy of ["configured", "none", undefined]) {
    assert.equal(getToolModeLabel(legacy), "build");
  }
  // Display compatibility is not a migration of a Chat-only session's tools.
  assert.deepEqual(getToolNamesForPreset("none"), []);
  assert.equal(getPresetFromToolNames([]), "none");
  assert.equal(isToolPreset("plan"), false);
  assert.equal(isToolPreset("build"), false);
});

test("new conversations default to full without changing unpinned historical build", () => {
  assert.equal(NEW_SESSION_TOOL_PRESET, "full");
  assert.deepEqual(getToolNamesForPreset(NEW_SESSION_TOOL_PRESET), ["bash", "read", "edit", "write", "grep", "find", "ls"]);
  assert.equal(DEFAULT_TOOL_PRESET, "default");
  assert.deepEqual(getToolNamesForPreset(DEFAULT_TOOL_PRESET), ["read", "bash", "edit", "write"]);
});

test("an active tool set never maps back to the configured preset", () => {
  for (const tools of [PRESET_NONE, PRESET_READ_ONLY, PRESET_DEFAULT, PRESET_FULL, ["read", "grep"]]) {
    assert.ok(isConcreteToolPreset(getPresetFromToolNames(tools)), tools.join(","));
  }
});
