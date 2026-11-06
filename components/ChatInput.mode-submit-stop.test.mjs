import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
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
  assert.ok(button(html, "Steer"));
  assert.ok(button(html, "Follow-up"));
  assert.match(html, /class="chat-composer-run-label">Steer<\/span>/);
  assert.match(html, /class="chat-composer-run-label">Follow-up<\/span>/);
  assert.equal(button(html, "Send"), undefined);
});
