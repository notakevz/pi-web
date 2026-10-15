import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Real React render-phase queues defer updater execution until a later render.
// The hook shim intentionally evaluates setters eagerly and cannot catch reads
// of mutable refs from queued updaters. Exercise the actual source statements
// here; HTTP/model sequencing is separately covered by the full hook tests.
const source = ts.createSourceFile("useAgentSession.ts", readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function find(node, matches) {
  if (matches(node)) return node;
  return ts.forEachChild(node, (child) => find(child, matches));
}
function compile(statement) {
  return new Script(ts.transpileModule(statement, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
}
const guardNode = find(source, (node) => ts.isIfStatement(node)
  && node.expression.getText(source) === "!modelSwitchPendingRef.current"
  && node.thenStatement.getText(source).includes("setCurrentThinkingOverride(null)"));
assert.ok(guardNode, "the actual reload checks pending before queueing state updates");
const cleanupNode = find(source, (node) => ts.isExpressionStatement(node)
  && node.getText(source).includes("setCurrentThinkingOverride((current) => current === preferred ? null : current)"));
assert.ok(cleanupNode, "the actual success cleanup preserves a newer explicit choice");
const actualGuard = compile(guardNode.getText(source));
const actualCleanup = compile(cleanupNode.getText(source));

function renderQueuedTransition({ guard = actualGuard, initial = "xhigh", pending = true } = {}) {
  function Probe() {
    const [model, setCurrentModelOverride] = React.useState("qwen");
    const [effort, setCurrentThinkingOverride] = React.useState(initial);
    const [revision, setRevision] = React.useState(0);
    const modelSwitchPendingRef = React.useRef(pending);
    const queued = React.useRef(false);
    if (!queued.current) {
      queued.current = true;
      // The reload has queued other state before reaching its override guard.
      setRevision(1);
      const context = { setCurrentModelOverride, setCurrentThinkingOverride, modelSwitchPendingRef, preferred: "low" };
      guard.runInNewContext(context);
      // Simulate the switch finally clearing the ref before React renders.
      modelSwitchPendingRef.current = false;
      actualCleanup.runInNewContext(context);
    }
    return React.createElement("span", null, `${model ?? "none"}/${effort ?? "none"}/${revision}`);
  }
  return renderToStaticMarkup(React.createElement(Probe));
}

test("real React deferred updates expose the old mutable-ref preservation bug", () => {
  const legacyGuard = compile("setCurrentThinkingOverride((current) => modelSwitchPendingRef.current ? current : null);");
  assert.equal(renderQueuedTransition({ guard: legacyGuard }), "<span>qwen/none/1</span>");
});

test("actual reload and completion preserve a later xhigh choice under real React queued rendering", () => {
  assert.equal(renderQueuedTransition(), "<span>qwen/xhigh/1</span>");
});

test("actual completion releases only the matching optimistic default", () => {
  assert.equal(renderQueuedTransition({ initial: "low" }), "<span>qwen/none/1</span>");
});

test("ordinary non-switch reloads still clear both overrides", () => {
  assert.equal(renderQueuedTransition({ pending: false }), "<span>none/none/1</span>");
});
