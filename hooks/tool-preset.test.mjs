import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { PRESET_DEFAULT, PRESET_FULL, PRESET_READ_ONLY } = await jiti.import("@/lib/tool-presets.ts");
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();
const preferences = new Map();
window.localStorage = {
  getItem: (key) => preferences.get(key) ?? null,
  setItem: (key, value) => preferences.set(key, value),
};
globalThis.EventSource = class {
  readyState = 0;
  close() { this.readyState = 2; }
};

test("fresh composers start in full regardless of old browser preferences", async () => {
  globalThis.fetch = async () => Response.json({ models: {}, modelList: [] });
  for (const preset of [undefined, "default", "read-only", "full", "none", "configured"]) {
    preferences.clear();
    if (preset) preferences.set("pi-tool-preset", preset);
    const hook = renderHook(useAgentSession, { session: null, newSessionCwd: "/project" });
    try {
      await settle();
      hook.flush();
      assert.equal(hook.result.toolPreset, "full");
    } finally {
      hook.unmount();
    }
  }
});

test("existing sessions ignore fresh-composer preferences: unpinned means build, none stays Chat only", async () => {
  for (const [toolNames, expected] of [
    [undefined, "default"], [[], "none"], [PRESET_READ_ONLY, "read-only"],
    [PRESET_DEFAULT, "default"], [PRESET_FULL, "full"],
  ]) {
    preferences.set("pi-tool-preset", "full");
    const commands = [];
    const tools = (toolNames ?? PRESET_FULL).map((name) => ({ name, description: name, active: true }));
    globalThis.fetch = async (url, init = {}) => {
      if (url.startsWith("/api/models")) return Response.json({ models: {}, modelList: [] });
      if (url.startsWith("/api/sessions/s1?")) return Response.json({
        toolNames, leafId: null, tree: [], context: { messages: [], entryIds: [], hasMore: false, oldestEntryId: null },
      });
      if (url === "/api/sessions/s1/state") return Response.json({ running: false });
      if (url === "/api/agent/s1" && init.body) {
        const command = JSON.parse(init.body);
        commands.push(command);
        return Response.json({ success: true, data: command.type === "get_tools" ? tools : {} });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const hook = renderHook(useAgentSession, { session: { id: "s1", cwd: "/project" } });
    try {
      assert.equal(hook.result.toolPreset, "default", "an existing session never starts from the stored full preference");
      await settle();
      hook.flush();
      assert.equal(hook.result.toolPreset, expected, "on-disk pin wins over browser preferences");
      await hook.result.loadTools("s1");
      hook.flush();
      assert.equal(hook.result.toolPreset, expected, "a live tools refresh keeps unpinned build and empty none intact");
      if (expected === "none") {
        assert.ok(!commands.some((command) => command.type === "set_tools"), "loading a legacy none session does not enable tools");
      }
    } finally {
      hook.unmount();
    }
  }
});
