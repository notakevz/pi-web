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
