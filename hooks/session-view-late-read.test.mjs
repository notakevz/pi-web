import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { peekSessionViewSnapshot, setSessionViewSnapshot, resetSessionViewCacheForTests } = await jiti.import("../lib/session-view-cache.ts");
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };

for (const status of [200, 404, 500]) {
  test(`late foreground ${status} cannot overwrite or delete a newer background completion`, async () => {
    const previous = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, EventSource: globalThis.EventSource };
    resetSessionViewCacheForTests();
    globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    globalThis.window = Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem: () => {} } });
    globalThis.EventSource = class {
      readyState = 0;
      constructor() { queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
      close() { this.readyState = 2; }
    };
    const id = `late-view-${status}`;
    let release, stateReads = 0, detailReads = 0;
    const unexpected = [];
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url) => {
      if (url.startsWith(`/api/sessions/${id}?`)) {
        detailReads++;
        await gate;
        return Response.json(status === 200 ? {
          sessionId: id, snapshotRevision: "old", treeFormat: "summary", tree: [], leafId: null, totalActiveMs: 0,
          context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: "off", model: null },
        } : { error: "old read failed" }, { status });
      }
      if (url === `/api/sessions/${id}/state`) { stateReads++; return Response.json({ running: false }); }
      if (url.startsWith("/api/models")) return Response.json({ models: {}, modelList: [] });
      if (url === `/api/agent/${id}?systemPrompt=0` || url === `/api/agent/${id}`) return Response.json({ running: false });
      unexpected.push(url);
      throw new Error(`unexpected fetch ${url}`);
    };
    let hook;
    try {
      hook = renderHook(useAgentSession, { session: { id, cwd: "/fixture" } });
      assert.equal(detailReads, 1);
      hook.unmount(); hook = null;
      // The final background read wins before the departed view's old HTTP reply.
      setSessionViewSnapshot({
        sessionId: id, revision: "final", messages: [{ role: "user", content: "final result" }],
        entryIds: ["final"], loadedEntryIds: ["final"], leafId: "final", oldestEntryId: "final",
        hasMore: false, turnsBefore: 0, summaryTree: [], thinkingLevel: "off", model: null,
      });
      const final = peekSessionViewSnapshot(id);
      release(); await settle();
      assert.strictEqual(peekSessionViewSnapshot(id), final);
      assert.equal(stateReads, 0, "departed hooks do not continue into state hydration");
      assert.deepEqual(unexpected, [], "status mocks must match even when the hook catches fetch errors");
    } finally {
      release(); hook?.unmount(); await settle();
      resetSessionViewCacheForTests();
      Object.assign(globalThis, previous);
    }
  });
}
