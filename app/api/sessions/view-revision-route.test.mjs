import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

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
    getEntries: () => entries,
    getLeafId: () => leafId,
    getSessionFile: () => filePath,
    getTree: () => {
      treeReads++;
      assert.equal(forbidProjection, false, "unchanged reads must not build the tree");
      return [];
    },
    getHeader: () => {
      assert.equal(forbidProjection, false, "unchanged reads must not hydrate metadata");
      return header;
    },
    getSessionName: () => undefined,
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
    message: { role: "assistant", content: [{ type: "text", text: "final result" }], timestamp: Date.parse(timestamp) },
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
});
