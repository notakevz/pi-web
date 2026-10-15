import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { getSessionViewSnapshot, setSessionViewSnapshot, resetSessionViewCacheForTests } = await jiti.import("../lib/session-view-cache.ts");
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("a warmed snapshot paints immediately, restores plan, and preserves paged history after fast validation", async () => {
  const previousFetch = globalThis.fetch, previousDocument = globalThis.document;
  const previousWindow = globalThis.window, previousSource = globalThis.EventSource;
  resetSessionViewCacheForTests();
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.window = Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem: () => {} } });
  globalThis.EventSource = class {
    readyState = 0;
    constructor() { queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
    close() { this.readyState = 2; }
  };
  const id = "warm-view-restore";
  const model = { provider: "fixture", modelId: "fixture" };
  const entryIds = Array.from({ length: 100 }, (_, index) => `e${index}`);
  const messages = entryIds.map((entryId) => ({ role: "user", content: entryId }));
  const toolNames = ["read", "grep", "find", "ls"];
  setSessionViewSnapshot({
    sessionId: id, revision: "warm-r1", messages, entryIds, leafId: "e99", oldestEntryId: "e0",
    hasMore: true, turnsBefore: 7, summaryTree: [], thinkingLevel: "medium", model,
    toolNames, loadedEntryIds: entryIds, totalActiveMs: 100,
  });
  let detailReads = 0;
  let releaseDetail;
  const detailGate = new Promise((resolve) => { releaseDetail = resolve; });
  globalThis.fetch = async (url) => {
    if (url.startsWith(`/api/sessions/${id}?`)) {
      detailReads++;
      await detailGate;
      return Response.json({
        sessionId: id, filePath: "", snapshotRevision: "warm-r1", treeFormat: "summary", tree: [],
        leafId: "e99", toolNames, totalActiveMs: 100,
        context: {
          messages: messages.slice(-50), entryIds: entryIds.slice(-50), oldestEntryId: "e50",
          hasMore: true, turnsBefore: 57, thinkingLevel: "medium", model,
        },
      });
    }
    if (url === `/api/sessions/${id}/state`) return Response.json({ running: false });
    if (url.startsWith("/api/models")) return Response.json({
      models: {}, modelList: [{ provider: model.provider, id: model.modelId, name: "Fixture" }],
      defaultModel: model, defaultThinkingLevel: "medium", thinkingLevels: { "fixture:fixture": ["off", "medium"] },
    });
    if (url === `/api/agent/${id}`) return Response.json({ running: false });
    throw new Error(`unexpected fetch ${url}`);
  };
  let hook;
  try {
    hook = renderHook(useAgentSession, { session: { id, cwd: "/fixture" } });
    hook.flush();
    assert.equal(hook.result.messages.length, 100, "cached content is visible before the network reply");
    assert.equal(hook.result.loading, false);
    assert.equal(hook.result.toolPreset, "read-only", "do not flash build for a cached plan session");
    // Resolve the foreground read before an additional hook flush, stressing the refs primed on mount.
    releaseDetail();
    await settle(); hook.flush();
    assert.equal(detailReads, 1);
    assert.equal(hook.result.messages.length, 100);
    assert.equal(hook.result.earlierTurnCount, 7);
    const cached = getSessionViewSnapshot(id);
    assert.equal(cached.messages.length, 100);
    assert.equal(cached.entryIds.length, 100, "the second cache write must not truncate only entry ids");
    assert.equal(cached.oldestEntryId, "e0");
    assert.deepEqual(cached.toolNames, toolNames);
    hook.unmount(); hook = null;
    assert.equal(getSessionViewSnapshot(id).messages.length, 100, "unmount keeps the warmed snapshot revision");
  } finally {
    releaseDetail();
    hook?.unmount();
    resetSessionViewCacheForTests();
    globalThis.fetch = previousFetch;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.EventSource = previousSource;
  }
});
