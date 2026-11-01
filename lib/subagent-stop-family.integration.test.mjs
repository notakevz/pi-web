import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentController, createSubagentNotificationCancellationExtension, hasUnsettledSubagentRun, subagentDebugSnapshot } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
const answer = (text) => fauxAssistantMessage([fauxText(text)]);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// All discovery, settings and session writes stay in a disposable directory. The sole provider
// is faux: no live models, service requests, shared settings or wrapper lifecycle replacement.
async function withFamily(check, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-stop-family-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const sessions = new Map();
  const reports = [];
  try {
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "fixture.md"), [
      "---", "description: Offline Stop family fixture", "tools: read", "load_skills: false",
      `load_extensions: ${options.extensions === true}`, "---", "Complete the delegated task.",
    ].join("\n"));
    // A completed child runs in plan mode (its profile keeps read only); only
    // scout/planner are admitted there, so give the nested case such a role.
    await writeFile(join(dir, "agents", "scout.md"), [
      "---", "description: Offline nested Stop fixture", "tools: read", "load_skills: false",
      "load_extensions: true", "---", "Inspect only.",
    ].join("\n"));
    await writeFile(join(dir, "agents", "settings.json"), JSON.stringify({ builtInEnabled: true, maxConcurrent: options.maxConcurrent ?? 8 }));
    if (options.extensions) {
      await mkdir(join(dir, "extensions"));
      await writeFile(join(dir, "extensions", "setup.ts"), `export default async function (pi) {
  await globalThis.__stopFamilySetupHook?.();
  pi.on("input", async () => await globalThis.__stopFamilyInputHook?.());
}\n`);
    }
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          ...(options.parentExtension ? [options.parentExtension] : []),
          createSubagentNotificationCancellationExtension(),
        ],
      },
    });
    const { session: parent } = await createAgentSessionFromServices({
      services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: faux.getModel(),
    });
    const full = (inner) => inner.sessionManager.appendCustomEntry("pi-web:tool-selection", {
      version: 1, tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });
    full(parent);
    let configure = () => {};
    const registerSession = (inner) => {
      const wrapper = {
        inner, cwd: dir, sessionFile: inner.sessionFile ?? "", stopping: false,
        isAlive: () => true, isRunning: () => inner.isStreaming,
        isStopping() { return this.stopping; }, waitUntilReady: async () => {},
      };
      inner.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "custom" && event.message.customType === "pi-web:subagent-notification") {
          reports.push({ owner: inner.sessionId, message: event.message });
        }
      });
      sessions.set(inner.sessionId, wrapper);
      configure(wrapper);
      return wrapper;
    };
    const owner = registerSession(parent);
    const dependencies = {
      getSession: (id) => sessions.get(id), registerSession,
      resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null,
      reopenSession: async (id) => sessions.get(id), invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
    };
    const controller = createSubagentController(dependencies);
    const requestFor = (wrapper = owner) => ({
      parentContext: { sessionManager: wrapper.inner.sessionManager }, parentToolCallId: "fixture-call",
      profile: "fixture", task: "Inspect", description: "Stop family", runInBackground: true,
    });
    const stop = async (wrapper = owner) => {
      wrapper.stopping = true;
      try { await Promise.all([wrapper.inner.abort(), controller.abortFamily(wrapper.inner.sessionId)]); }
      finally { wrapper.stopping = false; }
    };
    await check({ dir, faux, sessions, reports, owner, controller, runtime: controller.extensionRuntime,
      request: requestFor(), requestFor, stop, full, dependencies, configure: (callback) => { configure = callback; } });
  } finally {
    delete globalThis.__stopFamilySetupHook;
    delete globalThis.__stopFamilyInputHook;
    for (const { inner } of sessions.values()) inner.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

for (const kind of ["background", "foreground", "expired foreground wait"]) {
  test(`host Stop aborts ${kind}, awaits unwind, and never reactivates its parent`, { timeout: 10_000 }, async (t) => {
    await withFamily(async ({ faux, owner, controller, runtime, request, stop, reports }) => {
      const entered = deferred(), release = deferred();
      faux.setResponses([async () => { entered.resolve(); await release.promise; return answer("STOPPED"); }]);
      let execution;
      const signal = new AbortController();
      let toolResult;
      if (kind === "expired foreground wait") {
        const tools = new Map();
        await createSubagentExtension({ ...runtime, async start(value) {
          execution = await runtime.start(value); return execution;
        } }, () => []).factory({ registerTool(tool) { tools.set(tool.name, tool); } });
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const pending = tools.get("Agent").execute("expired", {
          subagent_type: "fixture", prompt: "Inspect", description: "Wait", run_in_background: false, wait_timeout: 1,
        }, signal.signal, undefined, request.parentContext);
        await entered.promise;
        await flush();
        t.mock.timers.tick(1_000);
        toolResult = await pending;
        assert.match(toolResult.content[0].text, /Wait budget exhausted/);
        // Mere cancellation of the expired tool wait still must NOT abort the child.
        signal.abort();
        assert.equal((await runtime.get(execution.run.sessionId)).status, "running");
        t.mock.timers.reset();
      } else {
        execution = await runtime.start({ ...request, runInBackground: kind === "background", signal: signal.signal });
        await entered.promise;
      }
      let settled = false;
      const stopping = stop().then(() => { settled = true; });
      await flush();
      assert.equal(settled, false, "Stop must wait for the SDK/provider unwind");
      assert.equal(globalThis.__piSubagentRuns.get(execution.run.sessionId).abortRequested, true);
      release.resolve();
      await stopping;
      const result = await execution.completion;
      assert.equal(result.status, "aborted");
      assert.equal(owner.isStopping(), false);
      // Deliver after the barrier falls: a stopped run retains suppression beyond host Stop.
      await runtime.notifyParent(result);
      await flush();
      assert.deepEqual(reports, []);
      assert.equal(hasUnsettledSubagentRun(owner.inner.sessionId), false);
      // Stop does not mutate the saved resource ceiling or make this child unresumable.
      faux.setResponses([answer("RESUMED")]);
      const resumed = await runtime.resume({ ...request, sessionId: result.sessionId });
      const completed = await resumed.completion;
      assert.equal(completed.status, "completed");
      await runtime.notifyParent(completed);
      assert.equal(reports.length, 1, "a genuinely new resume may report normally");
      assert.equal((await controller.get(result.sessionId)).result, "RESUMED");
    });
  });
}

test("Stop cancels a saturated queued child before awaiting the running sibling", { timeout: 10_000 }, async () => {
  await withFamily(async ({ faux, runtime, request, stop }) => {
    const entered = deferred(), release = deferred();
    faux.setResponses([async () => { entered.resolve(); await release.promise; return answer("RUNNING"); }]);
    const first = await runtime.start(request);
    await entered.promise;
    const queued = await runtime.start(request);
    assert.equal(queued.run.status, "queued");
    const stopping = stop();
    assert.equal((await queued.completion).status, "aborted", "queued cancellation cannot wait for capacity");
    release.resolve();
    await stopping;
    assert.equal((await first.completion).status, "aborted");
    assert.equal(faux.state.callCount, 1, "queued child's prompt never reached the provider");
  }, { maxConcurrent: 1 });
});

test("Stop cancels an MCP preflight wait without ever dispatching a prompt", { timeout: 10_000 }, async () => {
  await withFamily(async ({ configure, runtime, request, stop, faux }) => {
    const entered = deferred();
    configure((wrapper) => {
      wrapper.prepareMcpForRun = async (signal) => {
        entered.resolve();
        await new Promise((resolve) => signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }));
        return false;
      };
    });
    const execution = await runtime.start(request);
    await entered.promise;
    await stop();
    assert.equal((await execution.completion).status, "aborted");
    assert.equal(faux.state.callCount, 0);
  });
});

test("Stop broadcasts through nested full-mode descendants and refuses delegation during unwind", { timeout: 10_000 }, async () => {
  await withFamily(async ({ faux, sessions, runtime, controller, request, requestFor, stop, full, reports }) => {
    const firstEntered = deferred(), secondEntered = deferred(), release = deferred();
    faux.setResponses([
      async () => { firstEntered.resolve(); await release.promise; return answer("CHILD"); },
      async () => { secondEntered.resolve(); await release.promise; return answer("GRANDCHILD"); },
    ]);
    const child = await runtime.start(request);
    await firstEntered.promise;
    const childOwner = sessions.get(child.run.sessionId);
    full(childOwner.inner);
    const grandchild = await runtime.start(requestFor(childOwner));
    await secondEntered.promise;
    const queuedGrandchild = await runtime.start(requestFor(childOwner));
    assert.equal(queuedGrandchild.run.status, "queued");
    const stopping = stop();
    for (const execution of [child, grandchild]) {
      assert.equal(globalThis.__piSubagentRuns.get(execution.run.sessionId).abortRequested, true);
    }
    await assert.rejects(runtime.start(requestFor(childOwner)), /stopping/);
    await assert.rejects(controller.steer(grandchild.run.sessionId, "Continue", requestFor(childOwner).parentContext), /stopping/);
    assert.equal((await queuedGrandchild.completion).status, "aborted");
    release.resolve();
    await stopping;
    for (const execution of [child, grandchild, queuedGrandchild]) {
      const result = await execution.completion;
      assert.equal(result.status, "aborted");
      await runtime.notifyParent(result);
    }
    assert.deepEqual(reports, []);
    assert.equal(faux.state.callCount, 2);
  }, { maxConcurrent: 1 });
});

test("a subagent owner's Stop helper never waits on its own controller completion", { timeout: 10_000 }, async () => {
  await withFamily(async ({ faux, runtime, controller, request, reports }) => {
    const entered = deferred(), release = deferred();
    faux.setResponses([async () => { entered.resolve(); await release.promise; return answer("OWNER"); }]);
    const child = await runtime.start(request);
    await entered.promise;
    // A wrapper calls this concurrently with its own SDK abort. It must not await this
    // controller run: that can still be on the wrapper's calling tool/notification stack.
    await controller.abortFamily(child.run.sessionId);
    assert.equal(globalThis.__piSubagentRuns.has(child.run.sessionId), true);
    release.resolve();
    const result = await child.completion;
    assert.equal(result.status, "aborted");
    await runtime.notifyParent(result);
    assert.deepEqual(reports, []);
  });
});

test("Stop cancels start admission across awaited extension setup and awaits its cleanup", { timeout: 10_000 }, async () => {
  await withFamily(async ({ owner, runtime, controller, request, sessions, faux }) => {
    const entered = deferred(), release = deferred();
    globalThis.__stopFamilySetupHook = async () => { entered.resolve(); await release.promise; };
    const starting = runtime.start(request);
    const rejected = assert.rejects(starting, /stopping/);
    await entered.promise;
    owner.stopping = true;
    let settled = false;
    const stopping = controller.abortFamily(owner.inner.sessionId).then(() => { settled = true; });
    // Prove cancellation survives even when the transient wrapper flag goes away during setup.
    owner.stopping = false;
    await flush();
    assert.equal(settled, false);
    release.resolve();
    await rejected;
    await stopping;
    assert.equal(sessions.size, 1, "refused setup must not register a child");
    assert.equal(faux.state.callCount, 0);
    assert.equal(globalThis.__piSubagentAdmissions.size, 0);
  }, { extensions: true });
});

test("Stop cancels resume admission across awaited reopen, without changing its snapshot or result", { timeout: 10_000 }, async () => {
  await withFamily(async ({ faux, owner, runtime, request, controller, dependencies, sessions }) => {
    faux.setResponses([answer("INITIAL")]);
    const original = await (await runtime.start(request)).completion;
    const wrapper = sessions.get(original.sessionId);
    const before = JSON.stringify(wrapper.inner.sessionManager.getEntries());
    sessions.delete(original.sessionId);
    const entered = deferred(), release = deferred();
    const resumedController = createSubagentController({ ...dependencies,
      resolveSessionPath: async () => original.sessionPath,
      reopenSession: async () => { entered.resolve(); await release.promise; sessions.set(original.sessionId, wrapper); return wrapper; },
    });
    const resumed = resumedController.extensionRuntime.resume({ ...request, sessionId: original.sessionId });
    const rejected = assert.rejects(resumed, /stopping/);
    await entered.promise;
    const stopping = controller.abortFamily(owner.inner.sessionId);
    release.resolve();
    await rejected;
    await stopping;
    assert.equal(JSON.stringify(wrapper.inner.sessionManager.getEntries()), before);
    assert.equal(faux.state.callCount, 1);
    assert.equal((await runtime.get(original.sessionId)).result, "INITIAL");
  });
});

for (const heldAt of ["ready", "busy", "path lookup"]) {
  test(`Stop suppresses pending notification held at ${heldAt}, without awaiting parent idle or reopening it`, { timeout: 10_000 }, async () => {
    await withFamily(async ({ faux, owner, runtime, request, controller, reports, dependencies }) => {
      faux.setResponses([answer("FINISHED")]);
      const result = await (await runtime.start(request)).completion;
      const release = deferred(), entered = deferred();
      let busy = true, reopenCount = 0;
      let notifications = runtime;
      if (heldAt === "ready") owner.waitUntilReady = async () => { entered.resolve(); await release.promise; };
      else if (heldAt === "busy") owner.isRunning = () => busy;
      else {
        notifications = createSubagentController({ ...dependencies, getSession: () => undefined,
          resolveSessionPath: async () => { entered.resolve(); await release.promise; return owner.sessionFile; },
          reopenSession: async () => { reopenCount++; return owner; },
        }).extensionRuntime;
      }
      const delivery = notifications.notifyParent(result);
      if (heldAt === "busy") await flush();
      else await entered.promise;
      assert.equal(hasUnsettledSubagentRun(owner.inner.sessionId), true);
      await controller.abortFamily(owner.inner.sessionId);
      assert.equal(hasUnsettledSubagentRun(owner.inner.sessionId), false);
      assert.deepEqual(subagentDebugSnapshot(owner.inner.sessionId).notifications, []);
      busy = false;
      release.resolve();
      await delivery;
      await runtime.notifyParent(result);
      assert.deepEqual(reports, []);
      assert.equal(reopenCount, 0);
    });
  });
}

test("Stop during a child's delayed input preflight prevents its provider request (start and resume)", { timeout: 15_000 }, async () => {
  await withFamily(async ({ faux, runtime, request, controller, owner }) => {
    const calls = [];
    const gate = deferred();
    globalThis.__stopFamilyInputHook = async () => { await gate.promise; };
    faux.setResponses([() => { calls.push("child"); return answer("CHILD"); }]);
    const started = await runtime.start({ ...request, runInBackground: true });
    await flush();
    // Stop marks the family synchronously, then awaits unwind: release the held input
    // so the child can reach its real boundary instead of deadlocking the test.
    const stopping = controller.abortFamily(owner.inner.sessionId);
    gate.resolve();
    await stopping;
    const first = await started.completion;
    assert.equal(calls.length, 0, "a stopped start must not reach the provider");
    assert.equal(first.status, "aborted");

    // Resume: the first answer is consumed, the resumed run is stopped while its input waits.
    faux.setResponses([() => { calls.push("child"); return answer("CHILD"); }]);
    const resumedGate = deferred();
    globalThis.__stopFamilyInputHook = async () => { await resumedGate.promise; };
    const resumed = await runtime.resume({ ...request, sessionId: first.sessionId, runInBackground: true });
    await flush();
    const stoppingResume = controller.abortFamily(owner.inner.sessionId);
    resumedGate.resolve();
    await stoppingResume;
    const second = await resumed.completion;
    assert.equal(calls.length, 0, "a stopped resume must not reach the provider");
    assert.equal(second.status, "aborted");
  }, { extensions: true });
});

test("Stop reaches a running grandchild whose completed intermediate already delivered its report", { timeout: 15_000 }, async () => {
  await withFamily(async ({ faux, runtime, request, requestFor, owner, sessions, reports, controller }) => {
    faux.setResponses([answer("INTERMEDIATE")]);
    const intermediate = await runtime.start({ ...request, runInBackground: true });
    const done = await intermediate.completion;
    assert.equal(done.status, "completed");
    // B's report reaches A and leaves the pending set: only retained ancestry links C.
    await runtime.notifyParent(done);
    await flush();
    assert.equal(hasUnsettledSubagentRun(owner.inner.sessionId), false);

    const b = sessions.get(done.sessionId);
    assert.ok(b, "the completed intermediate's wrapper is still registered");
    const gate = deferred();
    let providerCalls = 0;
    globalThis.__stopFamilyInputHook = async () => { await gate.promise; };
    faux.setResponses([() => { providerCalls++; return answer("GRANDCHILD"); }]);
    const grandchild = await runtime.start({ ...requestFor(b), profile: "scout", runInBackground: true });
    await flush();
    assert.equal(hasUnsettledSubagentRun(owner.inner.sessionId), true, "A's family still holds C");
    const stopping = controller.abortFamily(owner.inner.sessionId);
    gate.resolve();
    await stopping;
    const result = await grandchild.completion;
    assert.equal(result.status, "aborted");
    assert.equal(providerCalls, 0);
    await flush();
    assert.equal(hasUnsettledSubagentRun(owner.inner.sessionId), false);
    assert.deepEqual(reports.map((entry) => entry.owner), [owner.inner.sessionId], "only B's own report reached A");
  }, { extensions: true });
});

test("a report the SDK deferred inside agent_settled is re-aborted at its real run boundary after Stop", { timeout: 15_000 }, async () => {
  const settleEntered = deferred(), settleRelease = deferred();
  const parentExtension = { name: "settled-hold", factory: (pi) => {
    pi.on("agent_settled", async () => { settleEntered.resolve(); await settleRelease.promise; });
  } };
  await withFamily(async ({ faux, runtime, request, owner, controller, reports }) => {
    let calls = 0;
    faux.setResponses([() => { calls++; return answer("CHILD"); }]);
    const execution = await runtime.start({ ...request, runInBackground: true });
    const done = await execution.completion;
    assert.equal(done.status, "completed");
    assert.equal(calls, 1);
    // A parent run settles while the handler holds it: message_start never fires for the
    // deferred report, so Stop must keep a cancellable token past sendCustomMessage's return.
    faux.setResponses([() => { calls++; return answer("PARENT"); }]);
    const parentTurn = owner.inner.prompt("parent turn");
    await settleEntered.promise;
    const delivery = runtime.notifyParent(done);
    await flush();
    assert.deepEqual(reports, [], "the deferred report has not started a turn yet");
    await controller.abortFamily(owner.inner.sessionId);
    settleRelease.resolve();
    await delivery;
    await parentTurn;
    for (let i = 0; i < 60 && calls < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 2, "the cancelled deferred report must never reach the provider");
    // Its message_start may already fire; what matters is that no provider request follows.
    assert.equal(reports.length, 1);
  }, { parentExtension });
});
