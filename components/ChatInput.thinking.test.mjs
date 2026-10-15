import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const model = { provider: "test", modelId: "capability-test" };
function render(props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, isStreaming: false, onThinkingLevelChange() {},
      model, modelList: [{ id: model.modelId, provider: model.provider, name: "Test", thinkingToggle: true }],
      availableThinkingLevels: ["off", "low", "medium", "xhigh"], thinkingLevel: "xhigh", ...props,
    })));
}
function reasoningButton(html) {
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([button]) => button).filter((button) => button.includes('aria-label="Change reasoning level"'));
  assert.equal(buttons.length, 1, "one unified reasoning menu trigger");
  assert.doesNotMatch(html, /aria-label="Toggle reasoning"|aria-pressed=/);
  assert.doesNotMatch(buttons[0], /disabled=/);
  assert.match(buttons[0], /aria-haspopup="listbox" aria-expanded="false"/);
  return buttons[0];
}

test("Qwen renders one correctly labelled reasoning trigger for each effort/off, including streaming", () => {
  for (const thinkingLevel of ["off", "low", "medium", "xhigh"]) {
    for (const isStreaming of [false, true]) {
      const label = thinkingLevel === "off" ? "Reasoning off" : `Reasoning · ${thinkingLevel}`;
      const html = render({ thinkingLevel, isStreaming, thinkingLevelMap: { off: "none" } });
      const button = reasoningButton(html);
      assert.ok(button.includes(`title="${label}"`));
      assert.ok(button.includes(`>${label}</span>`));
      assert.match(button, /<svg[^>]*width="11"[^>]*height="11"/);
      assert.match(button, /<path d="M9\.5 2A5\.5/);
      assert.doesNotMatch(button, /<polygon|>none</);
    }
  }
});

test("Gemma uses the same single menu trigger with on/off labels, never the internal medium marker", () => {
  for (const thinkingLevel of ["off", "medium"]) {
    for (const isStreaming of [false, true]) {
      const html = render({ availableThinkingLevels: ["off", "medium"], thinkingLevel, isStreaming });
      const button = reasoningButton(html);
      const label = thinkingLevel === "off" ? "Reasoning off" : "Reasoning on";
      assert.ok(button.includes(`title="${label}"`));
      assert.ok(button.includes(`>${label}</span>`));
      assert.doesNotMatch(button, /medium/);
    }
  }
});

test("neither Qwen nor Gemma has a toolbar default star or save action in any state", () => {
  for (const availableThinkingLevels of [["off", "low", "medium", "xhigh"], ["off", "medium"]]) {
    for (const thinkingLevel of availableThinkingLevels) {
      for (const savedDefaultThinkingLevel of [null, "off", thinkingLevel]) {
        for (const isStreaming of [false, true]) {
          const html = render({ availableThinkingLevels, thinkingLevel, savedDefaultThinkingLevel, isStreaming, onSetDefaultThinkingLevel() {} });
          reasoningButton(html);
          assert.doesNotMatch(html, /aria-label="(?:Default reasoning level for this model|Use and save as this model&#x27;s default reasoning level)"/);
          assert.doesNotMatch(html, /<polygon/);
        }
      }
    }
  }
});

test("missing off support or capability retains the ordinary reasoning picker", () => {
  for (const props of [
    { availableThinkingLevels: ["medium"], thinkingLevel: "medium" },
    { modelList: [{ id: model.modelId, provider: model.provider, name: "Test" }], thinkingLevel: "medium" },
    { model: { provider: "other", modelId: model.modelId }, thinkingLevel: "medium" },
  ]) {
    const button = reasoningButton(render(props));
    assert.match(button, />medium<\/span>/);
    assert.doesNotMatch(button, /Reasoning ·|Reasoning on/);
  }
  const gpt = reasoningButton(render({ modelList: [], thinkingLevel: "off" }));
  assert.match(gpt, />off<\/span>/);
});

test("unified trigger retains supported wire effort labels", () => {
  const mapped = reasoningButton(render({ thinkingLevel: "xhigh", thinkingLevelMap: { xhigh: "maximum" } }));
  assert.match(mapped, />Reasoning · maximum<\/span>/);
});
