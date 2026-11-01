import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isMcpTool, isReadOnlySelection, createReadOnlyMcpPolicyExtension } = await jiti.import("./mcp-read-only-policy.ts");
const { TOOL_SELECTION_TYPE } = await jiti.import("./session-tool-selection.ts");

test("a pinned selection is read-only when it names tools and none can write or run commands", () => {
  assert.equal(isReadOnlySelection(["read", "grep", "find", "ls"]), true);
  assert.equal(isReadOnlySelection(["read"]), true);
  // No pin follows pi's configured tools, and an empty pin is Chat only, which loads no MCP.
  assert.equal(isReadOnlySelection(undefined), false);
  assert.equal(isReadOnlySelection([]), false);
  for (const writer of ["bash", "powershell", "edit", "write"]) {
    assert.equal(isReadOnlySelection(["read", writer]), false, writer);
  }
});

test("parent policy allows genuine host controls but blocks the superseded dispatcher, including nested calls", () => {
  const PLAN = ["read", "grep", "find", "ls"], BUILD = ["read", "bash", "edit", "write"], FULL = [...BUILD, "grep", "find", "ls"];
  const registered = [...FULL.map((name) => ({ name, description: name })),
    { name: "subagent", description: "In plan/build, children cannot load extensions or MCP" },
    ...["Agent", "get_subagent_result", "steer_subagent"].map((name) => ({ name, description: name, exposure: "model-only", sourceInfo: { path: "<inline:pi-web-subagents>" } })),
    { name: "mcp__untrusted__tool", description: "MCP" },
  ];
  const handlers = new Map();
  let active = ["subagent", "mcp__untrusted__tool"], selection = PLAN;
  createReadOnlyMcpPolicyExtension().factory({
    on: (name, handler) => handlers.set(name, handler),
    getAllTools: () => registered, getActiveTools: () => active,
    setActiveTools: (names) => { active = names; },
  });
  const ctx = { sessionManager: { getEntries: () => [{ type: "custom", customType: TOOL_SELECTION_TYPE, data: { version: 1, tools: selection } }] } };
  for (selection of [PLAN, BUILD, FULL]) {
    const event = { systemPromptOptions: { selectedTools: active, promptGuidelines: [] } };
    handlers.get("before_agent_start")(event, ctx);
    assert.ok(active.includes("Agent"));
    assert.ok(!active.includes("subagent"));
    assert.deepEqual(event.systemPromptOptions.selectedTools, active);
    for (const parentToolCallId of [undefined, "script-call"]) {
      const call = (toolName, input) => handlers.get("tool_call")({ toolName, input, parentToolCallId }, ctx);
      assert.equal(call("get_subagent_result", { agent_id: "child" }), undefined);
      assert.match(call("subagent", { agent: "scout", task: "read" }).reason, /external subagent tool is disabled/);
      if (selection !== FULL) {
        assert.equal(call("Agent", { subagent_type: "scout" }), undefined);
        assert.equal(call("mcp__untrusted__tool", {}).block, true);
        assert.equal(call("Agent", { subagent_type: "general-purpose" }).block, true);
      }
    }
  }
});

test("MCP tools are the MCP extension's and any named mcp__", () => {
  const source = (path) => ({ path, source: "builtin", scope: "user", origin: "top-level" });
  assert.equal(isMcpTool({ name: "read_mcp_resource", sourceInfo: source("builtin:mcp") }), true);
  assert.equal(isMcpTool({ name: "mcp__docs__search", sourceInfo: source("/ext/other-mcp.ts") }), true);
  assert.equal(isMcpTool({ name: "web_search", sourceInfo: source("/ext/search.ts") }), false);
  assert.equal(isMcpTool({ name: "codemode", sourceInfo: source("builtin:codemode") }), false);
});
