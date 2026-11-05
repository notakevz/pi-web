import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentTools,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
const { filterLocalSubagentProfiles, localSubagentMode } = await jiti.import("./local-subagent-policy.ts");
const { createReadOnlyMcpPolicyExtension } = await jiti.import("./mcp-read-only-policy.ts");
const { appendSessionToolSelection, readSessionToolSelection } = await jiti.import("./session-tool-selection.ts");

const CONTROL_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];

// Only `get` answers, so the test can tell a call the model issued itself from one that reached
// the runtime from a script.
function recordingRuntime(getParentId = () => "parent-session") {
  const calls = [];
  const refuse = (name) => async () => {
    calls.push(name);
    throw new Error(`${name} must not run`);
  };
  return {
    calls,
    runtime: {
      start: refuse("start"),
      resume: refuse("resume"),
      async get(sessionId) {
        calls.push(`get:${sessionId}`);
        return {
          sessionId,
          sessionPath: "/tmp/child.jsonl",
          parentSessionId: getParentId(),
          parentToolCallId: "model-call",
          profile: "explore",
          description: "Find parser",
          task: "Find the parser",
          runInBackground: false,
          status: "completed",
          result: "The parser is in lib/parse.ts.",
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        };
      },
      steer: refuse("steer"),
      notifyParent: refuse("notifyParent"),
      markResultConsumed: () => calls.push("markResultConsumed"),
    },
  };
}

// Stands in for codemode: a direct tool that calls other tools through `ctx.executeTool()`.
function nestedCallerExtension(outcomes) {
  return (pi) => {
    pi.registerTool({
      name: "echo",
      label: "echo",
      description: "Return the text it was given.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: params.text }], details: undefined };
      },
    });
    pi.registerTool({
      name: "script",
      label: "script",
      description: "Call other tools the way a codemode script does.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const calls = [
          ["echo", { text: "nested calls work" }],
          ["Agent", { prompt: "Find the parser", description: "Find parser" }],
          ["get_subagent_result", { agent_id: "child-session" }],
          ["steer_subagent", { agent_id: "child-session", message: "Stop" }],
        ];
        for (const [name, args] of calls) {
          const outcome = await ctx.executeTool(name, args);
          outcomes.push({
            name,
            isError: outcome.isError,
            text: outcome.result.content.map((block) => block.text).join(""),
          });
        }
        return { content: [{ type: "text", text: "script done" }], details: undefined };
      },
    });
  };
}

async function createSession(dir, faux, extensionFactories) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory(),
    modelRuntime,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(dir),
    model: faux.getModel("faux-model"),
  });
  return session;
}

function textOf(message) {
  return message.content.map((block) => block.text ?? "").join("");
}

// A codemode script must not start, collect, or steer subagents: a run started from a script
// would carry a nested parentToolCallId that no transcript entry has, so the chat could not
// link to its session. The model itself keeps all three tools and can still call them.
test("subagent control tools are declared to the model but cannot be called from another tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-exposure-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { calls, runtime } = recordingRuntime(() => session?.sessionId ?? "parent-session");
    const outcomes = [];
    session = await createSession(dir, faux, [
      createSubagentExtension(runtime, () => []),
      nestedCallerExtension(outcomes),
    ]);

    const toolsByName = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
    for (const name of CONTROL_TOOLS) {
      assert.equal(toolsByName.get(name)?.exposure, "model-only", name);
      assert.equal(toolsByName.get(name)?.sourceInfo.path, "<inline:pi-web-subagents>", name);
    }
    const active = session.getActiveToolNames();
    for (const name of CONTROL_TOOLS) assert.ok(active.includes(name), `${name} should be active`);
    const callable = session.getCallableToolNames();
    assert.ok(callable.includes("echo"));
    for (const name of CONTROL_TOOLS) assert.ok(!callable.includes(name), `${name} should not be callable`);

    let declared = [];
    faux.setResponses([
      (context) => {
        declared = getCurrentTools(context.messages).map((tool) => tool.name);
        return fauxAssistantMessage(
          [fauxToolCall("get_subagent_result", { agent_id: "child-session" })],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage([fauxToolCall("script", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await session.prompt("run the script");

    for (const name of CONTROL_TOOLS) assert.ok(declared.includes(name), `${name} should be declared`);
    const modelResult = session.agent.state.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "get_subagent_result",
    );
    assert.equal(modelResult?.isError, false);
    assert.equal(textOf(modelResult), "Subagent child-session completed.\n\nThe parser is in lib/parse.ts.");
    assert.deepEqual(outcomes, [
      { name: "echo", isError: false, text: "nested calls work" },
      { name: "Agent", isError: true, text: "Tool Agent not found" },
      { name: "get_subagent_result", isError: true, text: "Tool get_subagent_result not found" },
      { name: "steer_subagent", isError: true, text: "Tool steer_subagent not found" },
    ]);
    // Only the model's own call reached the runtime and consumed the terminal result.
    assert.deepEqual(calls, ["get:child-session", "markResultConsumed"]);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Agent resume rejects the remaining creation overrides before dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-resume-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { calls, runtime } = recordingRuntime();
    const completed = await runtime.get("child-session");
    runtime.resume = async (request) => {
      calls.push(`resume:${request.sessionId}`);
      return { run: completed, completion: Promise.resolve(completed) };
    };
    session = await createSession(dir, faux, [createSubagentExtension(runtime, () => [])]);
    const params = { resume: "child-session", prompt: "Continue the task.", description: "Continue fixture" };
    const invoke = async (options) => {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Agent", { ...params, ...options })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      await session.prompt("Continue the existing child.");
      return session.agent.state.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "Agent",
      );
    };

    // `model` is offered on a new subagent, so a resume call can carry it; it must still be rejected
    // rather than silently switching the model under the resumed session.
    for (const override of [
      { model: "different-provider/different-model" }, { input_files: ["fact.txt"] }, { isolation: "worktree" },
    ]) {
      const rejected = await invoke(override);
      const name = Object.keys(override)[0];
      assert.equal(rejected?.isError, true, `${name} must not be silently ignored.`);
      assert.match(textOf(rejected), new RegExp(name));
      assert.deepEqual(calls, ["get:child-session"]);
    }

    // Empty defaults stay compatible, and so do the keys the tool no longer offers: a call written
    // against the old schema still validates, and the resumed child keeps its own settings.
    const result = await invoke({
      model: "", input_files: [], isolation: "", run_in_background: false,
      thinking: "low", max_turns: 8, inherit_context: true,
    });
    assert.equal(result?.isError, false);
    assert.match(textOf(result), /Subagent child-session completed/);
    assert.deepEqual(calls, ["get:child-session", "resume:child-session"]);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Agent exposes only the parameters the model can choose correctly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-schema-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { runtime } = recordingRuntime();
    session = await createSession(dir, faux, [createSubagentExtension(runtime, () => [])]);
    const agent = session.getAllTools().find((tool) => tool.name === "Agent");
    assert.deepEqual(Object.keys(agent.parameters.properties).sort(), [
      "description", "input_files", "isolation", "model", "prompt", "resume", "run_in_background", "subagent_type", "wait_timeout",
    ]);
    const resultTool = session.getAllTools().find((tool) => tool.name === "get_subagent_result");
    for (const tool of [agent, resultTool]) {
      assert.equal(tool.parameters.properties.wait_timeout.type, "integer");
      assert.equal(tool.parameters.properties.wait_timeout.minimum, 1);
      assert.ok(!tool.parameters.required.includes("wait_timeout"));
    }
    // The profile owns these; a model that guessed one used to win over the configured value.
    for (const removed of ["thinking", "max_turns", "inherit_context"]) {
      assert.equal(agent.parameters.properties[removed], undefined, `${removed} must not be offered.`);
    }
    // A string, not a "worktree" literal: a model that fills every optional field with "" must still
    // be able to start a subagent.
    assert.equal(agent.parameters.properties.isolation.type, "string");
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("real SDK mode changes refresh the host's profile declarations without reloading or exposing legacy subagent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-modes-"));
  let session;
  try {
    const PLAN = ["read", "grep", "find", "ls"], BUILD = ["read", "bash", "edit", "write"], FULL = [...BUILD, "grep", "find", "ls"];
    const profile = (name, scope, description) => ({ name, displayName: name, scope, description, tools: ["read"], enabled: true });
    const raw = [profile("scout", "global", "global scout"), profile("worker", "global", "global worker"),
      profile("scout", "project", "project scout"), profile("general-purpose", "builtin", "full general")];
    const selection = () => session ? readSessionToolSelection(session.sessionManager.getEntries()) : undefined;
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { runtime } = recordingRuntime(() => session.sessionId);
    let externalCalls = 0;
    const nested = [];
    session = await createSession(dir, faux, [
      createSubagentExtension(runtime, () => filterLocalSubagentProfiles(raw, selection()), () => true, () => localSubagentMode(selection())),
      createReadOnlyMcpPolicyExtension(),
      { name: "legacy-external", factory: (pi) => {
        pi.registerTool({ name: "subagent", label: "legacy", description: "In plan/build, children cannot load extensions or MCP", parameters: Type.Object({}),
          async execute() { externalCalls++; return { content: [{ type: "text", text: "must not run" }] }; },
        });
        pi.registerTool({ name: "nested", label: "nested", description: "nested caller", parameters: Type.Object({}),
          async execute(_id, _params, _signal, _update, ctx) {
            nested.push(await ctx.executeTool("subagent", {}));
            return { content: [{ type: "text", text: "done" }] };
          },
        });
      } },
    ]);
    assert.ok(session.getAllTools().some((tool) => tool.name === "subagent"), "legacy factory remains loaded; Web policy bounds model calls");
    for (const selected of [PLAN, BUILD, FULL, PLAN]) {
      appendSessionToolSelection(session.sessionManager, selected);
      let declared;
      faux.setResponses([
        (context) => {
          declared = getCurrentTools(context.messages);
          const prompt = JSON.stringify(context.messages);
          assert.match(prompt, /Run a task in a separate, inspectable subagent session/);
          assert.doesNotMatch(prompt, /Use Agent for a focused task|Use multiple background Agent calls|Use background mode for independent work|Do not duplicate work already delegated/);
          return selected === FULL
            ? fauxAssistantMessage([fauxToolCall("nested", {})], { stopReason: "toolUse" })
            : fauxAssistantMessage([fauxText("done")]);
        },
        fauxAssistantMessage([fauxText("done")]),
      ]);
      await session.prompt("Describe the allowed agents.");
      assert.ok(!declared.some((tool) => tool.name === "subagent"));
      for (const name of CONTROL_TOOLS) assert.ok(declared.some((tool) => tool.name === name), name);
      const description = declared.find((tool) => tool.name === "Agent").description;
      if (selected === FULL) {
        assert.match(description, /project scout/);
        assert.match(description, /full general/);
      } else {
        assert.match(description, /global scout/);
        assert.doesNotMatch(description, /project scout|full general/);
        if (selected === PLAN) assert.doesNotMatch(description, /global worker/);
        else assert.match(description, /global worker/);
      }
    }
    assert.equal(externalCalls, 0);
    assert.equal(nested.length, 1);
    assert.equal(nested[0].isError, true);
    assert.match(textOf(nested[0].result), /external subagent tool is disabled|Tool subagent not found/);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session with the subagent feature switched off registers no control tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-disabled-"));
  let session;
  try {
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const { runtime } = recordingRuntime();
    session = await createSession(dir, faux, [createSubagentExtension(runtime, () => [], () => false)]);

    const names = session.getAllTools().map((tool) => tool.name);
    for (const name of CONTROL_TOOLS) assert.ok(!names.includes(name), `${name} should not be registered`);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
