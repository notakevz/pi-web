import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Isolate SDK imports and settings reads from the caller's real agent/home.
const home = await mkdtemp(join(tmpdir(), "pi-view-revision-home-"));
const previousEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith("XDG_") || /SESSION.*(DIR|PATH|FILE|ID)/.test(key) || key === "PI_WEB_PASSWORD") delete process.env[key];
}
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
await mkdir(process.env.PI_CODING_AGENT_DIR);
test.after(async () => {
  process.env = previousEnv;
  await rm(home, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET } = await jiti.import("./[id]/route.ts");

test("background revision validation skips projections without touching the runtime", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-view-revision-"));
  const previousRegistry = globalThis.__piSessions;
  const id = "background-view-revision";
  const timestamp = "2026-10-14T00:00:00.000Z";
  const filePath = join(dir, "session.jsonl");
  const header = { type: "session", version: 3, id, timestamp, cwd: dir };
  const entries = [{
    type: "message", id: "u1", parentId: null, timestamp,
    message: { role: "user", content: "revision fixture", timestamp: Date.parse(timestamp) },
  }];
  await writeFile(filePath, `${JSON.stringify(header)}\n${JSON.stringify(entries[0])}\n`);
  let leafId = "u1", treeReads = 0, evictions = 0, forbidProjection = false;
  const manager = {
    getEntries: () => new Proxy(entries, {
      get(target, key, receiver) {
        if (key === Symbol.iterator) assert.equal(forbidProjection, false, "unchanged reads must not scan entries for notices or prices");
        return Reflect.get(target, key, receiver);
      },
    }),
    getLeafId: () => leafId,
    getSessionFile: () => filePath,
    getTree: () => {
      treeReads++;
      assert.equal(forbidProjection, false, "unchanged reads must not build the tree");
      return [];
    },
    // The header's cwd is needed to read the effective notices switch even on unchanged reads.
    getHeader: () => header,
    getSessionName: () => {
      assert.equal(forbidProjection, false, "unchanged reads must not hydrate metadata");
      return undefined;
    },
  };
  const wrapper = {
    isAlive: () => true, isRunning: () => true,
    inner: { sessionManager: manager, sessionId: id },
    sessionId: id, sessionFile: filePath, cwd: dir,
    evictIfDiskAhead: () => { evictions++; return false; },
    send: () => { throw new Error("background GET must not send runtime commands"); },
  };
  globalThis.__piSessions = new Map([[id, wrapper]]);
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    await rm(dir, { recursive: true, force: true });
  });
  const params = { params: Promise.resolve({ id }) };
  const query = "deferThinking=1&deferMedia=1&tree=summary";
  const read = (extra = "", base = query) => GET(new Request(`http://localhost/api/sessions/${id}?${base}${extra}`), params);
  const initialResponse = await read();
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.equal(initial.treeFormat, "summary");
  assert.ok(initial.snapshotRevision);
  assert.equal(treeReads, 1);

  forbidProjection = true;
  const unchangedResponse = await read(`&knownRevision=${initial.snapshotRevision}`);
  assert.equal(unchangedResponse.status, 200);
  assert.equal(unchangedResponse.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await unchangedResponse.json(), {
    sessionId: id, snapshotRevision: initial.snapshotRevision, unchanged: true,
  });
  assert.equal(treeReads, 1);
  assert.equal(evictions, 0);
  assert.equal(globalThis.__piSessions.get(id), wrapper);
  forbidProjection = false;

  // A representation-changing request and an explicit force always get detail.
  for (const [extra, base] of [
    [`&knownRevision=${initial.snapshotRevision}&tail=1`, query],
    [`&knownRevision=${initial.snapshotRevision}&force=1`, query],
    [`&knownRevision=${initial.snapshotRevision}`, "tree=summary&deferThinking=1"],
    ["&knownRevision=stale", query],
  ]) {
    const response = await read(extra, base);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.unchanged, undefined);
    assert.ok(Array.isArray(detail.context.messages));
  }
  assert.equal(evictions, 1, "only the explicit foreground force can probe eviction");

  entries.push({
    type: "message", id: "a1", parentId: "u1", timestamp,
    message: {
      role: "assistant", provider: "anthropic", model: "fixture", stopReason: "stop",
      content: [{ type: "text", text: "final result" }], timestamp: Date.parse(timestamp),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      diagnostics: [{ type: "anthropic_input_transformations", details: { transformations: [{ type: "thinking_dropped" }] } }],
    },
  });
  leafId = "a1";
  const appended = await (await read(`&knownRevision=${initial.snapshotRevision}`)).json();
  assert.notEqual(appended.snapshotRevision, initial.snapshotRevision);
  assert.equal(appended.unchanged, undefined);
  assert.equal(appended.context.messages.at(-1).content[0].text, "final result");

  leafId = "u1";
  const navigated = await (await read(`&knownRevision=${appended.snapshotRevision}`)).json();
  assert.notEqual(navigated.snapshotRevision, appended.snapshotRevision, "same entries, different active branch");
  assert.equal(navigated.context.messages.length, 1);

  await writeFile(filePath, `${JSON.stringify(header)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const rewritten = await (await read(`&knownRevision=${navigated.snapshotRevision}`)).json();
  assert.notEqual(rewritten.snapshotRevision, navigated.snapshotRevision, "disk fingerprint participates in validation");
  assert.equal(rewritten.unchanged, undefined);
  assert.equal(evictions, 1, "background validation never evicts even after file changes");

  leafId = "a1";
  const off = await (await read()).json();
  assert.equal(off.context.messages.at(-1).transcriptNotices, undefined);
  const globalSettings = join(process.env.PI_CODING_AGENT_DIR, "settings.json");
  const projectSettings = join(dir, ".pi", "settings.json");
  await mkdir(join(dir, ".pi"));
  const unchanged = async (revision) => {
    forbidProjection = true;
    try {
      const response = await read(`&knownRevision=${revision}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { sessionId: id, snapshotRevision: revision, unchanged: true });
    } finally {
      forbidProjection = false;
    }
  };
  await unchanged(off.snapshotRevision);

  // No session entries or bytes change: only the effective setting changes the revision.
  await writeFile(globalSettings, JSON.stringify({ showCacheMissNotices: true }));
  const on = await (await read(`&knownRevision=${off.snapshotRevision}`)).json();
  assert.equal(on.unchanged, undefined);
  assert.notEqual(on.snapshotRevision, off.snapshotRevision);
  assert.deepEqual(on.context.messages.at(-1).transcriptNotices, [{ kind: "thinking_dropped", count: 1 }]);
  assert.equal(entries.at(-1).message.transcriptNotices, undefined, "notices never mutate persisted messages");
  await unchanged(on.snapshotRevision); // Enabled unchanged reads must not scan notices either.

  await writeFile(projectSettings, JSON.stringify({ showCacheMissNotices: false }));
  const projectOff = await (await read(`&knownRevision=${on.snapshotRevision}`)).json();
  assert.equal(projectOff.unchanged, undefined);
  assert.equal(projectOff.snapshotRevision, off.snapshotRevision);
  assert.equal(projectOff.context.messages.at(-1).transcriptNotices, undefined);
  await unchanged(projectOff.snapshotRevision);

  await writeFile(projectSettings, JSON.stringify({ showCacheMissNotices: true }));
  const projectOn = await (await read(`&knownRevision=${projectOff.snapshotRevision}`)).json();
  assert.equal(projectOn.snapshotRevision, on.snapshotRevision);
  assert.deepEqual(projectOn.context.messages.at(-1).transcriptNotices, [{ kind: "thinking_dropped", count: 1 }]);
  await writeFile(globalSettings, JSON.stringify({ showCacheMissNotices: false }));
  await unchanged(projectOn.snapshotRevision); // A shadowed global change is not an effective change.
  await rm(projectSettings);
  const backOff = await (await read(`&knownRevision=${projectOn.snapshotRevision}`)).json();
  assert.equal(backOff.unchanged, undefined);
  assert.equal(backOff.snapshotRevision, off.snapshotRevision);
  assert.equal(backOff.context.messages.at(-1).transcriptNotices, undefined);
  assert.equal(evictions, 1, "settings validation never evicts or sends runtime commands");
});
