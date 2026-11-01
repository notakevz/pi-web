import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name, context) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  return new Script(ts.transpileModule(find(source).getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText).runInNewContext(context);
}
const render = props => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
  onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, onToolPresetChange() {}, toolPreset: "read-only", ...props,
})));
const button = (html, label) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];

test("running mode stays visible and disabled beside active-mode Steer/Follow-up", () => {
  const html = render({ isStreaming: true });
  const mode = button(html, "Change tool preset");
  assert.ok(mode, "mode menu remains visible");
  assert.match(mode, /disabled=""/);
  assert.match(html, />plan<\/span>/);
  assert.match(html, />Steer<\/button>/);
  assert.match(html, />Follow-up<\/button>/);
  assert.equal(button(html, "Send"), undefined);
});

test("stop pending shows ordinary disabled Send and editable next mode, with independent Stopping control", () => {
  const html = render({ isStreaming: false, isStopping: true });
  assert.doesNotMatch(button(html, "Change tool preset"), /disabled/);
  assert.match(button(html, "Send"), /disabled=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*title="Stop agent"/);
  assert.match(html, /Stopping…/);
  assert.doesNotMatch(html, />Steer<\/button>|>Follow-up<\/button>/);
});

test("Enter, Alt+Enter, direct Send and stale Steer/Follow-up callbacks cannot clear or submit while stopping", async () => {
  const calls = [];
  const stoppingRef = { current: true };
  const context = {
    stoppingRef, value: "preserved draft", attachedImages: [{ data: "AQID", mimeType: "image/png" }],
    isStreaming: false, onAudioUnlock() { calls.push("unlock"); },
    clearInput() { calls.push("clear"); }, onSend() { calls.push("send"); },
    onSteer() { calls.push("steer"); }, onFollowUp() { calls.push("followup"); },
    runBuiltinCommand() { calls.push("builtin"); },
    stop() { calls.push("stop"); },
  };
  const handleSend = callback("handleSend", context);
  const sendQueued = callback("sendQueued", context);
  const keydown = callback("handleKeyDown", {
    Date: { now: () => 1000 }, COMPOSITION_END_ENTER_GRACE_MS: 100,
    isMobile: false, isStreaming: false, enterSendMode: "enter",
    isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
    historyMenuOpen: false, inputHistory: [], slashMenuOpen: false, slashQuery: null,
    atMenuOpen: false, atQuery: null, onSteer: undefined, onFollowUp: undefined,
    handleSend, sendQueued, value: "preserved draft", stop() { calls.push("stop"); },
  });
  for (const altKey of [false, true]) keydown({
    key: "Enter", altKey, shiftKey: false, ctrlKey: false, metaKey: false,
    nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() {},
  });
  await handleSend(); sendQueued("steer"); sendQueued("followup");
  assert.deepEqual(calls, [], "no audio, clear, builtin or submission side effect");
});

test("ChatWindow keeps whole-task Stop and tool-free queue controls reachable for child-only activity", () => {
  const windowSource = ts.createSourceFile("ChatWindow.tsx", readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let input;
  function find(node) {
    if (!input && ts.isJsxSelfClosingElement(node) && node.tagName.getText(windowSource) === "ChatInput") input = node;
    ts.forEachChild(node, find);
  }
  find(windowSource);
  const context = {
    agentRunning: false, subagentsActive: true, isStopping: false, sessionBusy: true,
    handleSteer() {}, handleFollowUp() {}, handlePromptWithStreamingBehavior() {},
  };
  const props = {};
  for (const name of ["isStreaming", "isStopping", "onSteer", "onFollowUp", "onPromptWithStreamingBehavior"]) {
    const attr = input.attributes.properties.find(p => p.name?.getText(windowSource) === name);
    props[name] = new Script(`(${attr.initializer.expression.getText(windowSource)})`).runInNewContext(context);
  }
  const html = render(props);
  assert.match(button(html, "Change tool preset"), /disabled=""/);
  assert.match(html, /title="Stop agent"/);
  assert.match(html, />Steer<\/button>|>Follow-up<\/button>/);
  assert.equal(props.onSteer, context.handleSteer);
  assert.equal(props.onFollowUp, context.handleFollowUp);
  assert.equal(button(html, "Send"), undefined);
});

test("Stop's synchronous latch blocks rapid handlers before React rerenders", async () => {
  const stoppingRef = { current: false }, calls = [];
  const stop = callback("stop", { stoppingRef, onAbort() { calls.push("abort"); } });
  const send = callback("handleSend", { stoppingRef });
  const queue = callback("sendQueued", { stoppingRef });
  stop(); stop(); await send(); queue("steer"); queue("followup");
  assert.deepEqual(calls, ["abort"]);
});

test("a builtin lookup that resolves after Stop cannot clear or queue the draft", async () => {
  const stoppingRef = { current: false }, gate = Promise.withResolvers(), calls = [];
  const sendQueued = callback("sendQueued", {
    stoppingRef, value: "/mcp", attachedImages: [], onAudioUnlock() {}, onBuiltinCommand() {},
    canRunBuiltinSlashCommandWhileStreaming: () => false, isBareMcpCommand: () => true,
    runBuiltinCommand: () => gate.promise,
    clearInput() { calls.push("clear"); }, onPromptWithStreamingBehavior() { calls.push("prompt"); },
  });
  sendQueued("steer"); stoppingRef.current = true; gate.resolve(false);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
});
