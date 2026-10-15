import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The parent integration supplies cache.peek. Keep these lifecycle tests runnable
// even before that existing-file change lands, using only a temporary mock file.
const temporary = mkdtempSync(join(tmpdir(), "pi-background-hook-test-"));
const cacheMock = join(temporary, "cache.mjs");
writeFileSync(cacheMock, `
export const peekSessionViewSnapshot = (id) => globalThis.__backgroundHookTest.cache.get(id) ?? null;
export const getSessionViewSnapshot = peekSessionViewSnapshot;
export const deleteSessionViewSnapshot = (id) => globalThis.__backgroundHookTest.cache.delete(id);
export const setSessionViewSnapshot = (value) => {
  globalThis.__backgroundHookTest.cache.set(value.sessionId, { ...value, savedAt: Date.now() });
  return true;
};
`);
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const shim = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const cachePath = fileURLToPath(new URL("../lib/session-view-cache", import.meta.url));
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { react: shim, [cachePath]: cacheMock, "@/lib/session-view-cache": cacheMock },
});
const { renderHook } = await import(shim);
const { useBackgroundSessionRefresh } = await jiti.import("./useBackgroundSessionRefresh.ts");

async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function data(id, revision = "r1") {
  return {
    sessionId: id, snapshotRevision: revision, treeFormat: "summary", tree: [], leafId: null,
    totalActiveMs: 5, toolNames: ["read"],
    context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: "off", model: null },
  };
}
function inputs(running = ["a"], selected = null) {
  return { sessions: [{ id: "a", cwd: "/one" }, { id: "b", cwd: "/two" }], runningSessionIds: new Set(running), selectedSessionId: selected };
}

async function withBrowser(run, { visible = true, online = true } = {}) {
  const globals = ["document", "window", "navigator", "fetch", "setTimeout", "clearTimeout"];
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const oldNow = Date.now;
  let now = 0, serial = 0;
  const timers = new Map();
  const requests = [];
  const cache = new Map();
  const doc = new EventTarget(); doc.visibilityState = visible ? "visible" : "hidden";
  const win = new EventTarget(); const nav = { onLine: online };
  const mounted = [];
  const install = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  install("document", doc); install("window", win); install("navigator", nav);
  install("setTimeout", (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; });
  // WebKit/strict Web IDL implementations reject an arbitrary receiver. Node
  // and arrow-function timer mocks do not, hiding detached browser methods.
  install("clearTimeout", function (id) {
    if (this !== globalThis) throw new TypeError("Can only call Window.clearTimeout on instances of Window");
    timers.delete(id);
  });
  install("fetch", (url, init) => new Promise((resolve) => requests.push({ url, init, resolve })));
  globalThis.__backgroundHookTest = { cache };
  Date.now = () => now;
  const environment = {
    cache, requests, timers,
    render(props = inputs()) { const hook = renderHook(useBackgroundSessionRefresh, props); mounted.push(hook); return hook; },
    visibility(value) { doc.visibilityState = value ? "visible" : "hidden"; doc.dispatchEvent(new Event("visibilitychange")); },
    online(value) { nav.onLine = value; win.dispatchEvent(new Event(value ? "online" : "offline")); },
    async advance(ms = 0) {
      const end = now + ms;
      for (let guard = 0; guard < 100; guard++) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = end; await settle(); return; }
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      assert.fail("timer loop");
    },
    async answer(index, body = data("a")) {
      requests[index].resolve({ ok: true, status: 200, json: async () => body }); await settle();
    },
  };
  try { await run(environment); }
  finally {
    try {
      for (const hook of mounted) hook.unmount();
    } finally {
      Date.now = oldNow;
      delete globalThis.__backgroundHookTest;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  }
}

test("production timer defaults retain the Window receiver across refresh, reschedule and cleanup", async () => {
  await withBrowser(async (h) => {
    const detached = { clear: globalThis.clearTimeout };
    assert.throws(() => detached.clear(-1), /Window\.clearTimeout/, "negative control reproduces the old detached-method call");
    const hook = h.render();
    hook.rerender(inputs()); // Cancel a pending scheduled cycle.
    await h.advance();
    await h.answer(0); // Clear the request timeout and schedule the next cycle.
    hook.rerender(inputs(["a"], "a")); // Clear the next cycle while selecting it.
    hook.rerender(inputs(["b"], "a"));
    await h.advance(5_000);
    hook.unmount(); // Clear a pending request timeout after the abort settles.
    await h.answer(1, data("b"));
    assert.equal(h.timers.size, 0);
  });
});

test("hook reuses its controller across catalog/running poll inputs without any UI state or duplicate endpoints", async () => {
  await withBrowser(async (h) => {
    const hook = h.render();
    assert.equal(hook.result, undefined);
    await h.advance();
    assert.equal(h.requests.length, 1);
    await h.answer(0);
    hook.rerender(inputs());
    await h.advance(2_500);
    assert.equal(h.requests.length, 1);
    hook.rerender(inputs());
    await h.advance(2_500);
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests.every(({ url }) => url.startsWith("/api/sessions/a?")));
    await h.answer(1);
    assert.equal(h.cache.get("a").revision, "r1");
  });
});

test("visibility and online events pause, abort and wake pending completion reads", async () => {
  await withBrowser(async (h) => {
    const hook = h.render(); await h.advance();
    h.visibility(false);
    assert.equal(h.requests[0].init.signal.aborted, true);
    hook.rerender(inputs([]));
    await h.answer(0, data("a", "discard"));
    await h.advance(10_000);
    assert.equal(h.cache.size, 0);
    h.online(false); h.visibility(true); await h.advance();
    assert.equal(h.requests.length, 1);
    h.online(true); await h.advance();
    assert.equal(h.requests.length, 2);
    await h.answer(1, data("a", "final"));
    assert.equal(h.cache.get("a").revision, "final");
  });
});

test("initial hidden/offline state never fetches until both recover", async () => {
  await withBrowser(async (h) => {
    h.render(); await h.advance(10_000);
    assert.equal(h.requests.length, 0);
    h.visibility(true); await h.advance();
    assert.equal(h.requests.length, 0);
    h.online(true); await h.advance();
    assert.equal(h.requests.length, 1);
    await h.answer(0);
  }, { visible: false, online: false });
});

test("selection effect aborts late background writes; unmount removes all listeners and timers", async () => {
  await withBrowser(async (h) => {
    const hook = h.render(); await h.advance();
    hook.rerender(inputs(["a"], "a"));
    assert.equal(h.requests[0].init.signal.aborted, true);
    await h.answer(0, data("a", "late"));
    assert.equal(h.cache.size, 0);
    hook.rerender(inputs(["b"], "a"));
    await h.advance(5_000);
    assert.equal(h.requests.length, 2);
    hook.unmount();
    assert.equal(h.requests[1].init.signal.aborted, true);
    await h.answer(1, data("b", "unmounted"));
    h.visibility(false); h.visibility(true); h.online(false); h.online(true);
    await h.advance(20_000);
    assert.equal(h.requests.length, 2);
    assert.equal(h.cache.size, 0);
    assert.equal(h.timers.size, 0);
  });
});
