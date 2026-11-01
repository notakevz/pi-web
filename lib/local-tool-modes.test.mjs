import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { localToolPolicy, localToolCallBlockReason, localModeGuideline } = await jiti.import("./local-tool-modes.ts");
const PLAN = ["read", "grep", "find", "ls"];
const BUILD = ["read", "bash", "edit", "write"];
const FULL = [...BUILD, "grep", "find", "ls"];
const BUILD_ROLES = ["scout", "planner", "worker", "reviewer"];
const tools = [
  ...FULL.map((name) => ({ name, description: name })),
  { name: "subagent", description: "In plan/build, children cannot load extensions or MCP" },
];
const block = (selection, input) => localToolCallBlockReason(localToolPolicy(selection, tools), tools, "subagent", input);
const task = (agent) => ({ agent, task: "fixture task" });
const requests = (roles) => [
  ...roles.map(task),
  { tasks: roles.map(task) },
  { chain: roles.map(task) },
];

for (const [mode, selection, roles] of [
  ["plan", PLAN, ["scout", "planner"]],
  ["build", BUILD, BUILD_ROLES],
]) {
  test(`${mode} permits its roles in single, flat parallel and flat mixed chains`, () => {
    for (const input of requests(roles)) {
      assert.equal(block(selection, input), undefined);
      assert.equal(block(selection, { ...input, agentScope: "user" }), undefined);
    }
    assert.ok(roles.every((role) => localModeGuideline(mode).includes(role)));
  });

  test(`${mode} denies unknown roles and non-user root scopes before dispatch`, () => {
    for (const agent of ["unknown", "", null, 1]) {
      for (const input of [task(agent), { tasks: [task("scout"), task(agent)] }, { chain: [task("scout"), task(agent)] }]) {
        assert.match(block(selection, input), /only permits subagent roles/, JSON.stringify(input));
      }
    }
    for (const agentScope of ["project", "both", "unknown", "", null, 1]) {
      for (const input of requests(roles)) {
        assert.match(block(selection, { ...input, agentScope }), /user-level/);
      }
    }
    for (const invalid of [null, [], { tasks: {} }, { chain: {} }]) {
      assert.match(block(selection, invalid), /Invalid/);
    }
  });
}

test("plan rejects worker/reviewer singles and whole flat mixed four-role batches", () => {
  for (const agent of ["worker", "reviewer"]) assert.ok(block(PLAN, task(agent)));
  for (const input of [{ tasks: BUILD_ROLES.map(task) }, { chain: BUILD_ROLES.map(task) }]) {
    assert.match(block(PLAN, input), /only permits subagent roles: scout \/ planner/);
    assert.equal(block(BUILD, input), undefined);
  }
});

test("policy preserves an already-allowed order without trusting its membership", () => {
  for (const selection of [undefined, PLAN, BUILD, FULL, ["read"], []]) {
    const expected = localToolPolicy(selection, tools).active;
    const previous = [...expected].reverse();
    assert.deepEqual(localToolPolicy(selection, tools, previous).active, previous);
    // Wrong membership (even with the same length) must not be treated as a
    // stable allowed set; duplicates must not stand in for a required tool.
    for (const invalid of [
      [...previous, "unregistered"],
      ["unregistered", ...previous.slice(1)],
      previous.length > 1 ? [previous[1], ...previous.slice(1)] : ["unregistered"],
    ]) {
      assert.deepEqual(localToolPolicy(selection, tools, invalid).active, expected);
    }
  }
});

test("order stability still fills newly allowed tools and removes withdrawn tools", () => {
  const full = localToolPolicy(FULL, tools).active.reverse();
  const extra = { name: "new-default", description: "SDK 1.4 extension default" };
  assert.deepEqual(localToolPolicy(FULL, [...tools, extra], full).active, [...tools.map((tool) => tool.name), extra.name]);
  const hidden = tools.map((tool) => tool.name === "subagent" ? { ...tool, exposure: "hidden" } : tool);
  for (const selection of [undefined, PLAN, BUILD, FULL]) {
    const old = localToolPolicy(selection, tools).active.reverse();
    assert.deepEqual(localToolPolicy(selection, hidden, old).active, localToolPolicy(selection, hidden).active);
  }
});

test("shell resolution precedes stable-order comparison", () => {
  const withPowerShell = [...tools, { name: "powershell", description: "shell" }];
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const active = ["subagent", "write", "edit", shell, "read"];
  const policy = localToolPolicy(BUILD, withPowerShell, active, ["read", "powershell", "edit", "write"]);
  assert.equal(policy.mode, "build");
  assert.deepEqual(policy.active, active);
  assert.ok(localToolCallBlockReason(policy, withPowerShell, shell === "bash" ? "powershell" : "bash", {}));
});

test("full retains unrestricted roles/scopes; unpinned sessions use build", () => {
  for (const input of requests(["unknown", "worker"])) {
    assert.equal(block(FULL, { ...input, agentScope: "project" }), undefined);
  }
  assert.equal(localModeGuideline("full"), undefined);
  assert.equal(localToolPolicy(undefined, tools).mode, "build");
  for (const input of requests(BUILD_ROLES)) assert.equal(block(undefined, input), undefined);
  assert.ok(block(["read"], task("scout")));
  assert.ok(block([], task("scout")));
});
