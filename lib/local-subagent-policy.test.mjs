import assert from "node:assert/strict";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const {
  filterLocalSubagentProfiles, localSubagentMode, createLocalSubagentPolicy,
  parseLocalSubagentPolicy, assertLocalSubagentContinuation, createLocalSubagentPolicyExtension,
} = await jiti.import("./local-subagent-policy.ts");
const { readSubagentSessionResources, subagentExtensionLoaderOptions } = await jiti.import("./subagents.ts");
const plan = ["read", "grep", "find", "ls"];
const build = ["read", "bash", "edit", "write"];
const full = [...build, "grep", "find", "ls"];
const profile = (name, scope = "global", enabled = true) => ({
  name, displayName: name, scope, enabled, tools: ["read", "bash", "edit", "write"], filePath: join(getAgentDir(), "agents", `${name}.md`),
});
const snapshot = (localPolicy) => ({ version: 1, appendSystemPrompt: [], tools: [...localPolicy.builtins], loadSkills: false, loadExtensions: false, localPolicy });
const entries = (resourceSnapshot) => [{ type: "custom", customType: "pi-web:subagent", data: {
  version: 1, parentSessionId: "parent", parentSessionPath: "/parent.jsonl", profile: resourceSnapshot.localPolicy?.role ?? "scout", resourceSnapshot,
} }];

test("normal unpinned parents are build; limited role selection precedes effective overrides", () => {
  assert.equal(localSubagentMode(undefined), "build");
  const sources = [profile("scout"), profile("scout", "project", false), profile("planner"),
    profile("worker"), profile("reviewer"), profile("explore", "builtin"), profile("planner", "workspace")];
  assert.deepEqual(filterLocalSubagentProfiles(sources, plan).map((p) => `${p.scope}/${p.name}`), ["global/scout", "global/planner"]);
  assert.deepEqual(filterLocalSubagentProfiles(sources, undefined).map((p) => p.name), ["scout", "planner", "worker", "reviewer"]);
  assert.deepEqual(filterLocalSubagentProfiles(sources, full).map((p) => `${p.scope}/${p.name}`), ["builtin/explore", "workspace/planner", "global/reviewer", "global/worker"]);
  assert.deepEqual(filterLocalSubagentProfiles(sources, []), []);
  assert.deepEqual(filterLocalSubagentProfiles([profile("scout", "builtin"), profile("scout", "project")], plan), []);
});

test("scout and planner force read-only in both modes; workers keep profile builtins only", () => {
  for (const mode of ["plan", "build"]) for (const role of ["scout", "planner"]) {
    assert.deepEqual(createLocalSubagentPolicy(profile(role), mode).builtins, plan);
  }
  const worker = createLocalSubagentPolicy({ ...profile("worker"), tools: [...full, "codemode", "Agent", "evil"] }, "build");
  assert.deepEqual(worker.builtins, full);
  assert.throws(() => createLocalSubagentPolicy(profile("worker"), "plan"), /allowed global/);
});

test("versioned provenance restores explicit webfetch only, and rejects malformed/widened snapshots", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "local-subagent-resources-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, "extensions"));
  writeFileSync(join(dir, "extensions", "webfetch.ts"), "export default () => {};");
  const policy = { ...createLocalSubagentPolicy(profile("scout"), "plan"), webfetch: true };
  const raw = { ...snapshot(policy), tools: [...plan, "webfetch"] };
  const restored = readSubagentSessionResources(entries(raw));
  assert.deepEqual(restored.localPolicy, policy);
  const options = subagentExtensionLoaderOptions(restored);
  assert.equal(options.noExtensions, true);
  assert.equal(options.noSkills, true);
  assert.equal(options.noContextFiles, true);
  assert.deepEqual(options.additionalExtensionPaths, [join(getAgentDir(), "extensions", "webfetch.ts")]);
  for (const patch of [
    { localPolicy: { ...policy, version: 2 } }, { localPolicy: null }, { localPolicy: { ...policy, scope: "project" } },
    { localPolicy: { ...policy, builtins: [...plan, "write"] } }, { tools: [...raw.tools, "Agent"] },
    { localPolicy: { ...policy, sourcePath: "/project/scout.md" } }, { localPolicy: { ...policy, sourcePath: "scout.md" } },
    { loadExtensions: true }, { loadSkills: true }, { mcp: true }, { codemode: true },
    { allExtensionTools: true }, { skills: [] }, { extensions: [] }, { tools: ["read"] },
  ]) assert.equal(readSubagentSessionResources(entries({ ...raw, ...patch })), null, JSON.stringify(patch));
  assert.equal(parseLocalSubagentPolicy({ ...policy, builtins: ["read", "read", "find", "ls"] }), null);
  const mismatched = entries(raw);
  mismatched[0].data.profile = "worker";
  assert.equal(readSubagentSessionResources(mismatched), null);
  // Old/full snapshots keep their upstream resource behavior, without inventing provenance.
  assert.ok(readSubagentSessionResources(entries({ version: 1, tools: ["read"], appendSystemPrompt: [] })));
  rmSync(join(dir, "extensions", "webfetch.ts"));
  assert.throws(() => subagentExtensionLoaderOptions(restored), /regular file/);
  mkdirSync(join(dir, "extensions", "webfetch.ts"));
  assert.throws(() => subagentExtensionLoaderOptions(restored), /regular file/);
  assert.equal(createLocalSubagentPolicy(profile("scout"), "plan").webfetch, false);
});

test("limited continuation refuses unknown/old/full children and current ceiling violations", () => {
  const sources = [profile("scout"), profile("worker")];
  const workerPolicy = { ...createLocalSubagentPolicy(sources[1], "build"), webfetch: false };
  const resources = readSubagentSessionResources(entries(snapshot(workerPolicy)));
  assert.doesNotThrow(() => assertLocalSubagentContinuation(resources, build, sources));
  assert.throws(() => assertLocalSubagentContinuation(resources, plan, sources), /admitted/);
  assert.throws(() => assertLocalSubagentContinuation(null, build, sources), /admitted/);
  const legacy = readSubagentSessionResources(entries({ version: 1, tools: ["read"], appendSystemPrompt: [] }));
  assert.throws(() => assertLocalSubagentContinuation(legacy, build, sources), /admitted/);
  assert.throws(() => assertLocalSubagentContinuation(resources, build, [profile("worker", "project")]), /admitted/);
  assert.throws(() => assertLocalSubagentContinuation(resources, build, [{ ...sources[1], tools: ["read"] }]), /ceiling/);
  assert.doesNotThrow(() => assertLocalSubagentContinuation(resources, full, sources));
  assert.deepEqual(resources.tools, workerPolicy.builtins, "full continuation does not widen saved resources");
});

test("immutable execution guard covers nested calls and requires vetted explicit webfetch provenance", () => {
  const policy = { ...createLocalSubagentPolicy(profile("scout"), "plan"), webfetch: true };
  const extension = createLocalSubagentPolicyExtension(policy);
  policy.builtins.push("write");
  const handlers = new Map();
  let tools = [
    { name: "read", description: "read", sourceInfo: { path: "builtin:read" } }, { name: "write", description: "write", sourceInfo: { path: "builtin:write" } },
    { name: "webfetch", description: "Read-only webfetch: GET only", annotations: { readOnlyHint: true }, sourceInfo: { path: join(getAgentDir(), "extensions", "webfetch.ts") } },
  ];
  let active;
  extension.factory({ on: (name, fn) => handlers.set(name, fn), getAllTools: () => tools,
    setActiveTools: (names) => { active = names; }, getActiveTools: () => active });
  handlers.get("session_start")();
  assert.deepEqual(active, ["read", "webfetch"]);
  const call = (name) => handlers.get("tool_call")({ toolName: name, toolCallId: "nested/1" });
  assert.equal(call("read"), undefined);
  assert.equal(call("webfetch"), undefined);
  for (const name of ["write", "Agent", "subagent", "get_subagent_result", "steer_subagent", "codemode", "tool_search", "mcp__evil"]) assert.equal(call(name).block, true);
  const vetted = tools[2];
  for (const patch of [{ annotations: {} }, { description: "unvetted" }, { sourceInfo: { path: "/project/webfetch.ts" } }, { exposure: "hidden" }]) {
    tools = [tools[0], { ...vetted, ...patch }];
    assert.equal(call("webfetch").block, true);
  }
  tools = [{ name: "read", description: "extension impersonation", sourceInfo: { path: "/extension.ts" } }];
  assert.equal(call("read").block, true);
});
