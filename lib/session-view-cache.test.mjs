import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clearSessionViewCache,
  deleteSessionViewSnapshot,
  getSessionViewSnapshot,
  peekSessionViewSnapshot,
  resetSessionViewCacheForTests,
  setSessionViewSnapshot,
  snapshotCoversLoadedEntries,
} = await jiti.import("./session-view-cache.ts");

function snapshot(overrides = {}) {
  return {
    sessionId: "s1",
    revision: "rev-1",
    messages: [{ role: "user", content: "hello" }],
    entryIds: ["e1"],
    leafId: "e1",
    oldestEntryId: "e1",
    hasMore: false,
    thinkingLevel: "off",
    model: null,
    loadedEntryIds: ["e1"],
    ...overrides,
  };
}

test("stores, reads, and deletes one snapshot with LRU touch", () => {
  resetSessionViewCacheForTests();
  assert.equal(setSessionViewSnapshot(snapshot()), true);
  assert.equal(getSessionViewSnapshot("s1")?.revision, "rev-1");
  assert.equal(getSessionViewSnapshot("missing"), null);
  deleteSessionViewSnapshot("s1");
  assert.equal(getSessionViewSnapshot("s1"), null);
});

test("refuses snapshots without a session id or revision", () => {
  resetSessionViewCacheForTests();
  assert.equal(setSessionViewSnapshot(snapshot({ sessionId: "" })), false);
  assert.equal(setSessionViewSnapshot(snapshot({ revision: "" })), false);
  assert.equal(getSessionViewSnapshot("s1"), null);
});

test("evicts least-recently-used sessions beyond the session cap", () => {
  resetSessionViewCacheForTests();
  for (let i = 0; i < 9; i++) {
    setSessionViewSnapshot(snapshot({ sessionId: `s${i}`, revision: `rev-${i}` }));
  }
  assert.equal(getSessionViewSnapshot("s0"), null, "oldest session evicted");
  assert.equal(getSessionViewSnapshot("s8")?.revision, "rev-8");
});

test("reading a snapshot refreshes its recency", () => {
  resetSessionViewCacheForTests();
  for (let i = 0; i < 8; i++) {
    setSessionViewSnapshot(snapshot({ sessionId: `s${i}`, revision: `rev-${i}` }));
  }
  // Touch s0 so it becomes most-recently used.
  assert.ok(getSessionViewSnapshot("s0"));
  setSessionViewSnapshot(snapshot({ sessionId: "s8", revision: "rev-8" }));
  assert.ok(getSessionViewSnapshot("s0"), "touched session survives eviction");
  assert.equal(getSessionViewSnapshot("s1"), null, "untouched oldest is evicted");
});

test("background peeks preserve object identity without promoting LRU recency", () => {
  resetSessionViewCacheForTests();
  for (let i = 0; i < 8; i++) setSessionViewSnapshot(snapshot({ sessionId: `s${i}` }));
  assert.strictEqual(peekSessionViewSnapshot("s0"), peekSessionViewSnapshot("s0"));
  setSessionViewSnapshot(snapshot({ sessionId: "s8" }));
  assert.equal(peekSessionViewSnapshot("s0"), null);
  assert.ok(peekSessionViewSnapshot("s1"));
});

test("background peeks enforce TTL and snapshots retain explicit tools", () => {
  resetSessionViewCacheForTests();
  setSessionViewSnapshot(snapshot({ toolNames: ["read"] }));
  const cached = peekSessionViewSnapshot("s1");
  assert.deepEqual(cached.toolNames, ["read"]);
  const now = Date.now;
  try {
    Date.now = () => cached.savedAt + 10 * 60_000 + 1;
    assert.equal(peekSessionViewSnapshot("s1"), null);
  } finally { Date.now = now; }
  assert.equal(getSessionViewSnapshot("s1"), null);
});

test("refused oversized replacements keep the previous good snapshot", () => {
  resetSessionViewCacheForTests();
  setSessionViewSnapshot(snapshot());
  const previous = peekSessionViewSnapshot("s1");
  assert.equal(setSessionViewSnapshot(snapshot({
    revision: "too-large", messages: [{ role: "user", content: "x".repeat(33 * 1024 * 1024) }],
  })), false);
  assert.strictEqual(peekSessionViewSnapshot("s1"), previous);
});

test("protected foreground snapshots survive byte-budget pressure, not just the entry cap", () => {
  resetSessionViewCacheForTests();
  const big = (sessionId, size) => snapshot({ sessionId, messages: [{ role: "user", content: "x".repeat(size * 1024 * 1024) }] });
  setSessionViewSnapshot(big("foreground", 24));
  setSessionViewSnapshot(snapshot({ sessionId: "background", revision: "old" }));
  const foreground = peekSessionViewSnapshot("foreground");
  const background = peekSessionViewSnapshot("background");
  assert.equal(setSessionViewSnapshot(big("background", 16), "foreground"), false);
  assert.strictEqual(peekSessionViewSnapshot("foreground"), foreground);
  assert.strictEqual(peekSessionViewSnapshot("background"), background);

  resetSessionViewCacheForTests();
  setSessionViewSnapshot(big("foreground", 20));
  setSessionViewSnapshot(big("idle", 8));
  assert.equal(setSessionViewSnapshot(big("background", 8), "foreground"), true);
  assert.ok(peekSessionViewSnapshot("foreground"), "the oldest protected entry is not evicted");
  assert.ok(peekSessionViewSnapshot("background"));
  assert.equal(peekSessionViewSnapshot("idle"), null);
});

test("clearSessionViewCache drops every entry (logout path)", () => {
  resetSessionViewCacheForTests();
  setSessionViewSnapshot(snapshot({ sessionId: "a" }));
  setSessionViewSnapshot(snapshot({ sessionId: "b" }));
  clearSessionViewCache();
  assert.equal(getSessionViewSnapshot("a"), null);
  assert.equal(getSessionViewSnapshot("b"), null);
});

test("coverage check treats paged-in entries as covered only when recorded", () => {
  const base = snapshot({ entryIds: ["e1", "e2"] });
  assert.equal(snapshotCoversLoadedEntries(base, []), true);
  assert.equal(snapshotCoversLoadedEntries(base, ["e1"]), true);
  assert.equal(snapshotCoversLoadedEntries(base, ["e9"]), false);
  assert.equal(
    snapshotCoversLoadedEntries({ ...base, loadedEntryIds: ["e1", "e2", "e3", "e4"] }, ["e3", "e4"]),
    true,
  );
});

test("storing a snapshot measures only that snapshot", () => {
  resetSessionViewCacheForTests();
  const serialized = new Map();
  const counted = (id) => ({ toJSON() { serialized.set(id, (serialized.get(id) ?? 0) + 1); return {}; } });
  for (const id of ["a", "b", "c", "d"]) {
    assert.equal(setSessionViewSnapshot(snapshot({ sessionId: id, stats: counted(id) })), true);
  }
  assert.deepEqual([...serialized.values()], [1, 1, 1, 1]);
});

test("evicts the oldest sessions once stored sizes pass the byte budget", () => {
  resetSessionViewCacheForTests();
  const big = (id) => snapshot({ sessionId: id, messages: [{ role: "user", content: "x".repeat(11 * 1024 * 1024) }] });
  assert.equal(setSessionViewSnapshot(big("a")), true);
  assert.equal(setSessionViewSnapshot(big("b")), true);
  assert.equal(setSessionViewSnapshot(big("c")), true);
  assert.equal(getSessionViewSnapshot("a"), null);
  assert.ok(getSessionViewSnapshot("b"));
  assert.ok(getSessionViewSnapshot("c"));
});
