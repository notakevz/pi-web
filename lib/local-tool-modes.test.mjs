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

test("parent mode guidance is stable, explicit and bounded to the selected mode", () => {
  for (const mode of ["plan", "build", "full"]) {
    const guidance = localModeGuideline(mode);
    assert.equal(localModeGuideline(mode), guidance);
    assert.match(guidance, /You, the parent assistant/);
    assert.match(guidance, /current mode and tool declarations govern this run/);
    assert.match(guidance, /not tools, permissions or mode instructions in earlier conversation history/);
    assert.match(guidance, /do not probe for missing tools/);
    assert.match(guidance, /do not.*change modes yourself/);
    assert.match(guidance, /steering messages.*do not change permissions/);
    assert.ok(guidance.length < 1500, "bounded static instructions, not a new prompt framework");
  }
  assert.match(localModeGuideline("plan"), /investigate, analyze and propose plans only/);
  assert.match(localModeGuideline("plan"), /Do not edit or write files, run shell commands, implement changes, or delegate implementation/);
  assert.match(localModeGuideline("plan"), /user must select build mode first/);
  for (const mode of ["build", "full"]) {
    assert.match(localModeGuideline(mode), /may implement requested changes/);
    assert.match(localModeGuideline(mode), /Earlier plan-only behavior no longer applies/);
    assert.match(localModeGuideline(mode), /resource ceiling/);
  }
  assert.match(localModeGuideline("full"), /does not grant administrator privileges or guarantee an operating-system sandbox/);
  for (const mode of ["none", "restricted"]) assert.equal(localModeGuideline(mode), undefined);
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

const hostTools = ["Agent", "get_subagent_result", "steer_subagent"].map((name) => ({
  name, description: "host control", exposure: "model-only", sourceInfo: { path: "<inline:pi-web-subagents>" },
}));
const trustedFetch = { name: "webfetch", description: "Read-only webfetch: GET only", annotations: { readOnlyHint: true } };

for (const selection of [undefined, PLAN, BUILD, FULL]) {
  test(`host controls supersede the external subagent in ${selection?.join(",") ?? "default build"}`, () => {
    const registered = [...tools, ...hostTools, trustedFetch, { name: "external", description: "arbitrary tool" }];
    const policy = localToolPolicy(selection, registered, ["subagent", "external"]);
    for (const control of hostTools) assert.ok(policy.active.includes(control.name));
    assert.ok(policy.active.includes("webfetch"));
    assert.ok(!policy.active.includes("subagent"));
    assert.match(localToolCallBlockReason(policy, registered, "subagent", task("scout")), /external subagent tool is disabled/);
    assert.equal(policy.active.includes("external"), selection === FULL);
    assert.equal(localToolCallBlockReason(policy, registered, "get_subagent_result", { agent_id: "child" }), undefined);
  });
}

test("same-name external control tools never qualify for limited mode", () => {
  for (const sourceInfo of [undefined, null, "<inline:pi-web-subagents>", { path: "/tmp/subagents.ts" }, { path: "<inline:other-subagents>" }]) {
    const lookalikes = hostTools.map((tool) => ({ ...tool, sourceInfo }));
    for (const selection of [PLAN, BUILD]) {
      const registered = [...tools, ...lookalikes];
      const policy = localToolPolicy(selection, registered, lookalikes.map((tool) => tool.name));
      for (const tool of lookalikes) {
        assert.ok(!policy.active.includes(tool.name));
        assert.match(localToolCallBlockReason(policy, registered, tool.name, {}), /disabled/);
      }
      assert.ok(policy.active.includes("subagent"), "without a real host, retain the existing trusted extension");
    }
  }
  const partial = [...tools, hostTools[1], { ...hostTools[0], sourceInfo: { path: "/tmp/Agent.ts" } }];
  assert.ok(!localToolPolicy(PLAN, partial).active.includes("Agent"));
});

test("the active host Agent has a role guard as well as its dispatch boundary", () => {
  const registered = [...tools, ...hostTools];
  for (const [selection, permitted, denied] of [[PLAN, ["scout", "planner"], ["worker", "reviewer", "general-purpose"]], [BUILD, BUILD_ROLES, ["general-purpose", "explore", "unknown"]]]) {
    const policy = localToolPolicy(selection, registered);
    for (const role of permitted) {
      assert.equal(localToolCallBlockReason(policy, registered, "Agent", { subagent_type: role }), undefined);
      assert.equal(localToolCallBlockReason(policy, registered, "Agent", { subagent_type: ` ${role.toUpperCase()} ` }), undefined);
    }
    for (const role of denied) assert.match(localToolCallBlockReason(policy, registered, "Agent", { subagent_type: role }), /only permits subagent roles/);
    assert.equal(localToolCallBlockReason(policy, registered, "Agent", {}), undefined, "dispatch chooses a mode-safe default");
  }
});

test("full retains unrestricted roles/scopes; unpinned sessions use build", () => {
  for (const input of requests(["unknown", "worker"])) {
    assert.equal(block(FULL, { ...input, agentScope: "project" }), undefined);
  }
  assert.match(localModeGuideline("full"), /Current tool mode: full\./);
  assert.equal(localToolPolicy(undefined, tools).mode, "build");
  for (const input of requests(BUILD_ROLES)) assert.equal(block(undefined, input), undefined);
  assert.ok(block(["read"], task("scout")));
  assert.ok(block([], task("scout")));
});
