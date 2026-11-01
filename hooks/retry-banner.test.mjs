import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);

// The event handler's cases for one run that fails, waits and retries.
const cases = ["agent_end", "auto_retry_start", "agent_start", "auto_retry_end"].map((type) => {
  const clause = nodes.find((node) => ts.isCaseClause(node) && node.expression.getText(source) === `"${type}"`);
  assert.ok(clause, `missing case ${type}`);
  return clause.getText(source);
});
const observe = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "observeSdkAgentRun");
const observeRun = new Script(ts.transpileModule(`(${observe.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
const handler = new Script(ts.transpileModule(`((event) => { switch (event.type) { ${cases.join("\n")} } })`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);

function setup() {
  const banner = { current: null };
  const context = createContext({
    agentRunningRef: { current: true }, sdkAgentActiveRef: { current: true }, sessionIdRef: { current: null },
    agentRunNeedsCompletionRef: { current: true }, agentRunEndRef: { current: { aborted: false } },
    sdkAgentGenerationRef: { current: 0 }, notifiedPromptRunIdRef: { current: -1 },
    setRetryInfo: (value) => { banner.current = value; },
    cancelEventStreamGrace() {}, setAgentRunning() {}, setAgentPhase() {}, dispatch() {}, markPromptLanded() {},
  });
  context.observeSdkAgentRun = observeRun.runInContext(context);
  return { handle: handler.runInContext(context), banner };
}

test("the retry banner shows while a retry waits and goes once the retried run starts", () => {
  const { handle, banner } = setup();
  handle({ type: "agent_end", willRetry: true });
  handle({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" });
  assert.deepEqual({ ...banner.current }, { attempt: 1, maxAttempts: 3, errorMessage: "overloaded" });
  // pi emits the successful auto_retry_end only after the retry's first complete reply.
  handle({ type: "agent_start" });
  assert.equal(banner.current, null);
  handle({ type: "auto_retry_end", success: true, attempt: 1 });
  assert.equal(banner.current, null);
});
