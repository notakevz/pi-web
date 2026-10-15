import assert from "node:assert/strict";
import test from "node:test";
import { hasThinkingToggle, thinkingControlState } from "./thinking-controls.ts";

const qwen = ["off", "low", "medium", "xhigh"];

test("thinking toggle is transport capability driven, not model-name or level-count guessing", () => {
  for (const thinkingFormat of ["qwen", "qwen-chat-template"]) {
    assert.equal(hasThinkingToggle({ reasoning: true, compat: { thinkingFormat } }), true);
  }
  assert.equal(hasThinkingToggle({ reasoning: true, compat: {
    thinkingFormat: "chat-template", chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
  } }), true);
  for (const model of [
    { reasoning: false, compat: { thinkingFormat: "qwen" } },
    { reasoning: true },
    { reasoning: true, compat: { thinkingFormat: "openrouter" } },
    { reasoning: true, compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { enable_thinking: true } } },
    { reasoning: true, compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled", omitWhenOff: true } } } },
  ]) assert.equal(hasThinkingToggle(model), false);
});

test("Qwen's unified menu contains off followed by every real effort, regardless of selection", () => {
  for (const level of qwen) {
    const control = thinkingControlState(qwen, level, true);
    assert.equal(control.mode, "toggle-levels");
    assert.equal(control.enabled, level !== "off");
    assert.deepEqual(control.levels, qwen);
    assert.deepEqual(control.menuLevels, qwen);
  }
});

test("binary transports expose on's actual SDK marker then off, without invented effort levels", () => {
  for (const marker of ["medium", "xhigh"]) {
    for (const current of ["off", marker]) {
      const control = thinkingControlState(["off", marker], current, true);
      assert.equal(control.mode, "toggle");
      assert.equal(control.enabled, current !== "off");
      assert.deepEqual(control.menuLevels, [marker, "off"]);
    }
  }
});

test("ordinary, always-on and unknown models retain SDK-supported levels, never invented off", () => {
  assert.equal(thinkingControlState(["medium"], "medium", true).mode, "levels");
  const efforts = ["low", "medium", "xhigh"];
  assert.deepEqual(thinkingControlState(efforts, "low", true).menuLevels, efforts);
  assert.equal(thinkingControlState(qwen, "medium", false).mode, "levels");
  assert.deepEqual(thinkingControlState(qwen, "medium", false).levels, qwen);
  assert.deepEqual(thinkingControlState(qwen, "off", false).menuLevels, qwen);
  assert.equal(thinkingControlState(["off"], "off", false).mode, "none");
  assert.equal(thinkingControlState([], null, true).mode, "none");
  assert.equal(thinkingControlState(null, null, true).mode, "levels");
  assert.equal(thinkingControlState(undefined, null, true).mode, "levels");
});
