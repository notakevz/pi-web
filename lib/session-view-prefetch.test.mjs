import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSessionViewPrefetchController } = await jiti.import("./session-view-prefetch.ts");

async function settle() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

function data(id, revision = "r1", count = 2, extra = {}) {
  const entryIds = Array.from({ length: count }, (_, index) => `entry-${index}`);
  return {
    sessionId: id, snapshotRevision: revision, treeFormat: "summary", tree: [],
    totalActiveMs: 100, leafId: entryIds.at(-1) ?? null, toolNames: ["read"],
    context: {
      messages: entryIds.map(() => ({ role: "user", content: "confirmed" })), entryIds,
      oldestEntryId: entryIds[0] ?? null, hasMore: true, turnsBefore: 3,
      thinkingLevel: "high", model: { provider: "test", modelId: "model" },
    }, stats: { totalTokens: 5 }, ...extra,
  };
}
function snapshot(id, revision = "r1", count = 2) {
  const value = data(id, revision, count);
  return {
    sessionId: id, revision, ...value.context, leafId: value.leafId,
    summaryTree: value.tree, loadedEntryIds: value.context.entryIds,
    toolNames: value.toolNames, totalActiveMs: value.totalActiveMs,
    stats: value.stats, savedAt: 0,
  };
}
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function row(id, extra = {}) { return { id, cwd: `/projects/${id}`, ...extra }; }

function harness({ ids = ["a"], selected = null, running = ids, auto = null, refuseAbove = Infinity } = {}) {
  let now = 0;
  let serial = 0;
  const timers = new Map();
  const cache = new Map();
  const requests = [];
  const protectedIds = [];
  const writeProtections = [];
  const controller = createSessionViewPrefetchController({
    now: () => now,
    setTimer: (callback, delay) => {
      const id = ++serial;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    cache: {
      peek: (id) => cache.get(id) ?? null,
      set: (value, protectedSessionId) => {
        writeProtections.push(protectedSessionId);
        cache.delete(value.sessionId);
        if (value.messages.length > refuseAbove) return false;
        cache.set(value.sessionId, { ...value, savedAt: now });
        if (cache.size > 8) cache.delete(cache.keys().next().value);
        return true;
      },
      delete: (id) => cache.delete(id),
      protect: (id) => {
        protectedIds.push(id);
        const value = cache.get(id);
        if (value) { cache.delete(id); cache.set(id, value); }
      },
    },
    fetch: (url, init) => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const id = decodeURIComponent(url.split("/").at(-1).split("?")[0]);
      const request = { url, init, id, at: now, resolve, reject };
      requests.push(request);
      if (auto) resolve(auto(request));
      return promise;
    },
  });
  let inputs = { sessions: ids.map((id) => typeof id === "string" ? row(id) : id), runningSessionIds: new Set(running), selectedSessionId: selected };
  controller.update(inputs);
  controller.start();
  return {
    controller, cache, requests, timers, protectedIds, writeProtections,
    update(changes) { inputs = { ...inputs, ...changes }; controller.update(inputs); },
    async advance(ms = 0) {
      const end = now + ms;
      for (let guard = 0; guard < 200; guard++) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = end; await settle(); return; }
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      assert.fail("timer loop");
    },
    async answer(index, body = data(requests[index].id), status = 200) {
      requests[index].resolve(response(body, status));
      await settle();
    },
  };
}

test("warms cached and unvisited running sessions on a 5 s cadence; no other endpoints", async () => {
  const h = harness({ ids: ["a", "b"], auto: ({ id }) => response(data(id)) });
  h.cache.set("a", snapshot("a"));
  await h.advance();
  assert.deepEqual(h.requests.map(({ id }) => id), ["a", "b"]);
  assert.equal(h.cache.get("a").revision, "r1");
  assert.equal(h.cache.get("b").thinkingLevel, "high");
  assert.deepEqual(h.cache.get("b").toolNames, ["read"]);
  h.update({ runningSessionIds: new Set(["a", "b"]) });
  await h.advance(4_999);
  assert.equal(h.requests.length, 2);
  await h.advance(1);
  assert.equal(h.requests.length, 4);
  for (const request of h.requests) {
    const url = new URL(request.url, "https://example.com");
    assert.match(url.pathname, /^\/api\/sessions\/[ab]$/);
    assert.equal(url.searchParams.get("deferThinking"), "1");
    assert.equal(url.searchParams.get("deferMedia"), "1");
    assert.equal(url.searchParams.get("tree"), "summary");
    assert.equal(url.searchParams.has("force"), false);
    assert.equal(request.init.cache, "no-store");
    assert.ok(request.init.signal instanceof AbortSignal);
  }
  assert.equal(new URL(h.requests[0].url, "https://example.com").searchParams.get("knownRevision"), "r1");
  assert.equal(new URL(h.requests[1].url, "https://example.com").searchParams.has("knownRevision"), false);
  h.controller.stop();
});

test("excludes foreground, known subagents, unknown running ids, and unrelated idle history", async () => {
  const h = harness({ ids: [row("selected"), row("sub", { relation: { kind: "subagent" } }), row("idle"), row("other-project")], running: ["selected", "sub", "missing", "other-project"], selected: "selected", auto: ({ id }) => response(data(id)) });
  await h.advance(10_000);
  assert.deepEqual(new Set(h.requests.map(({ id }) => id)), new Set(["other-project"]));
  h.controller.stop();
});

test("two workers, six targets per regular cycle, fair rotation and no overlapping cycles", async () => {
  const ids = Array.from({ length: 10 }, (_, index) => `s${index}`);
  const h = harness({ ids });
  await h.advance();
  assert.equal(h.requests.length, 2);
  h.update({ runningSessionIds: new Set(ids) });
  await h.advance(5_000);
  assert.equal(h.requests.length, 2, "a cycle never overlaps an in-flight one");
  await h.answer(0); await h.answer(1);
  assert.equal(h.requests.length, 4);
  await h.answer(2); await h.answer(3);
  assert.equal(h.requests.length, 6);
  await h.answer(4); await h.answer(5);
  await h.advance();
  assert.equal(h.requests.length, 8);
  assert.deepEqual(h.requests.slice(6).map(({ id }) => id), ["s6", "s7"]);
  // Delayed workers themselves still get a five-second per-session cooldown.
  await h.answer(6); await h.answer(7);
  await h.answer(8); await h.answer(9);
  if (h.requests[10]) await h.answer(10);
  if (h.requests[11]) await h.answer(11);
  const byId = new Map();
  for (const request of h.requests) {
    if (byId.has(request.id)) assert.ok(request.at - byId.get(request.id) >= 5_000);
    byId.set(request.id, request.at);
  }
  h.controller.stop();
});

test("background insertions keep the selected snapshot in the bounded cache", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
  const h = harness({ ids: ["foreground", ...ids], running: ids, selected: "foreground", auto: ({ id }) => response(data(id)) });
  h.cache.set("foreground", snapshot("foreground"));
  await h.advance(15_000);
  assert.equal(h.cache.size, 8);
  assert.ok(h.cache.has("foreground"));
  assert.ok(h.protectedIds.length >= 12);
  assert.ok(h.writeProtections.length >= 12);
  assert.ok(h.writeProtections.every((id) => id === "foreground"), "byte-budget eviction also receives the protection");
  h.controller.stop();
});

test("completion bypasses cooldown and an in-flight running request cannot consume the final read", async () => {
  const h = harness();
  await h.advance();
  h.update({ runningSessionIds: new Set() });
  await h.advance(1_000);
  assert.equal(h.requests.length, 1);
  await h.answer(0, data("a", "running"));
  await h.advance();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].at, 1_000);
  await h.answer(1, data("a", "final"));
  assert.equal(h.cache.get("a").revision, "final");
  await h.advance(20_000);
  assert.equal(h.requests.length, 2, "idle history isn't continually polled");
  h.controller.stop();
});

test("a quick completion gets a final read even before the first timer; selected completions never become targets", async () => {
  const h = harness({ ids: ["a", "selected"], selected: "selected", running: ["a", "selected"], auto: ({ id }) => response(data(id, "final")) });
  h.update({ runningSessionIds: new Set() });
  h.update({ selectedSessionId: null });
  await h.advance();
  assert.deepEqual(h.requests.map(({ id }) => id), ["a"]);
  h.controller.stop();
});

test("hidden/offline abort and discard replies, retaining final reads until visible and online", async () => {
  const h = harness();
  await h.advance();
  h.controller.setEnvironment({ visible: false, online: true });
  assert.equal(h.requests[0].init.signal.aborted, true);
  h.update({ runningSessionIds: new Set() });
  await h.answer(0, data("a", "stale"));
  await h.advance(8_000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.cache.size, 0);
  h.controller.setEnvironment({ visible: true, online: false });
  await h.advance();
  assert.equal(h.requests.length, 1);
  h.controller.setEnvironment({ visible: true, online: true });
  await h.advance();
  assert.equal(h.requests.length, 2);
  // Pause a final request too; it must not consume a retry or the final intent.
  h.controller.setEnvironment({ visible: false, online: false });
  await h.answer(1, data("a", "discard"));
  h.controller.setEnvironment({ visible: true, online: true });
  await h.advance();
  await h.answer(2, data("a", "final"));
  assert.equal(h.cache.get("a").revision, "final");
  h.controller.stop();
});

test("failures preserve the last snapshot; final retries are capped and expire while paused", async () => {
  const h = harness({ auto: () => response({ error: "do not log this body" }, 503) });
  const old = snapshot("a"); h.cache.set("a", old);
  h.update({ runningSessionIds: new Set() });
  await h.advance(20_000);
  assert.equal(h.requests.length, 3);
  assert.equal(h.cache.get("a"), old);
  h.controller.stop();

  const paused = harness({ auto: ({ id }) => response(data(id)) });
  paused.controller.setEnvironment({ visible: false, online: true });
  paused.update({ runningSessionIds: new Set() });
  await paused.advance(10 * 60_000);
  paused.controller.setEnvironment({ visible: true, online: true });
  await paused.advance();
  assert.equal(paused.requests.length, 0, "expired completions don't fetch unrelated idle history");
  paused.controller.stop();
});

test("a refused oversized replacement restores last good history even with a destructive cache writer", async () => {
  const h = harness({ refuseAbove: 3 });
  h.cache.set("a", snapshot("a", "old", 2));
  await h.advance();
  await h.answer(0, data("a", "oversized", 4));
  assert.equal(h.cache.get("a").revision, "old");
  assert.equal(h.cache.get("a").entryIds.length, 2);
  h.controller.stop();
});

test("404 deletes only the identical still-background snapshot", async () => {
  const h = harness(); h.cache.set("a", snapshot("a"));
  await h.advance();
  await h.answer(0, {}, 404);
  assert.equal(h.cache.has("a"), false);
  h.controller.stop();

  const newer = harness(); newer.cache.set("a", snapshot("a"));
  await newer.advance();
  const foreground = snapshot("a", "foreground"); newer.cache.set("a", foreground);
  await newer.answer(0, {}, 404);
  assert.equal(newer.cache.get("a"), foreground);
  newer.controller.stop();

  const selected = harness(); const old = snapshot("a"); selected.cache.set("a", old);
  await selected.advance(); selected.update({ selectedSessionId: "a" });
  await selected.answer(0, {}, 404);
  assert.equal(selected.cache.get("a"), old);
  selected.controller.stop();
});

test("foreground cache changes, selection roundtrips and catalog removal discard late results", async () => {
  for (const scenario of ["new-cache", "selection", "removed", "subagent", "stopped"]) {
    const h = harness();
    await h.advance();
    if (scenario === "new-cache") h.cache.set("a", snapshot("a", "foreground"));
    if (scenario === "selection") {
      h.update({ selectedSessionId: "a" });
      h.update({ selectedSessionId: null });
    }
    if (scenario === "removed") h.update({ sessions: [] });
    if (scenario === "subagent") h.update({ sessions: [row("a", { relation: { kind: "subagent" } })] });
    if (scenario === "stopped") h.controller.stop();
    await h.answer(0, data("a", "late"));
    assert.notEqual(h.cache.get("a")?.revision, "late", scenario);
    h.controller.stop();
  }
});

test("unchanged reply refreshes timestamp and keeps every cached field and wider history", async () => {
  const h = harness();
  const old = { ...snapshot("a", "r1", 100), extraMetadata: "kept" };
  h.cache.set("a", old);
  await h.advance();
  await h.advance(1_000);
  await h.answer(0, { sessionId: "a", snapshotRevision: "r1", unchanged: true });
  assert.deepEqual(h.cache.get("a"), { ...old, savedAt: 1_000 });
  assert.equal(old.savedAt, 0, "never mutate the captured object");
  h.controller.stop();
});

test("same revision full reply preserves paging with new metadata; changed revision cannot collapse a wide page", async () => {
  const h = harness(); h.cache.set("a", snapshot("a", "r1", 100));
  await h.advance();
  await h.answer(0, data("a", "r1", 2, { totalActiveMs: 200 }));
  const wide = h.cache.get("a");
  assert.equal(wide.entryIds.length, 100);
  assert.equal(wide.loadedEntryIds.length, 100);
  assert.equal(wide.totalActiveMs, 200);
  await h.advance(5_000);
  await h.answer(1, data("a", "r2", 50));
  assert.equal(h.cache.get("a"), wide);
  h.controller.stop();
});

test("malformed, unstable, wrong-id and invalid unchanged replies never enter the cache", async () => {
  const bodies = [data("different"), data("a", null), data("a", "r2", 2, { context: {} }),
    data("a", "r2", 2, { error: "not a history snapshot" }),
    { sessionId: "a", unchanged: true, snapshotRevision: "wrong" }];
  for (const body of bodies) {
    const h = harness(); const old = snapshot("a"); h.cache.set("a", old);
    await h.advance(); await h.answer(0, body);
    assert.equal(h.cache.get("a"), old);
    h.controller.stop();
  }
  const miss = harness(); await miss.advance();
  await miss.answer(0, { sessionId: "a", unchanged: true, snapshotRevision: "r1" });
  assert.equal(miss.cache.size, 0);
  miss.controller.stop();
});

test("normalizes raw tool call fields and stores only confirmed history", async () => {
  const h = harness(); await h.advance();
  const value = data("a", "r1", 1, { isStreaming: true, queuedMessages: ["private"], dialogs: [] });
  value.context.messages[0] = { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "file" } }] };
  await h.answer(0, value);
  const cached = h.cache.get("a");
  assert.deepEqual(cached.messages[0].content[0], { type: "toolCall", toolCallId: "call", toolName: "read", input: { path: "file" } });
  assert.equal("isStreaming" in cached, false);
  assert.equal("queuedMessages" in cached, false);
  assert.equal("dialogs" in cached, false);
  h.controller.stop();
});

test("stop/restart waits for the old cycle and never accepts its replies", async () => {
  const h = harness(); await h.advance();
  h.controller.stop(); h.controller.start();
  await h.advance(5_000);
  assert.equal(h.requests.length, 1);
  await h.answer(0, data("a", "old-mount"));
  assert.equal(h.cache.size, 0);
  await h.advance();
  assert.equal(h.requests.length, 2);
  await h.answer(1, data("a", "new-mount"));
  assert.equal(h.cache.get("a").revision, "new-mount");
  h.controller.stop();
});
