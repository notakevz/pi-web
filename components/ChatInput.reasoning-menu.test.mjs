import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";
import { thinkingControlState } from "../lib/thinking-controls.ts";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { SelectorRow } = await jiti.import("./SelectorRow.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { defaultThinkingLevelFor } = await jiti.import("@/hooks/useAgentSession");
const { getLocalePlugin } = await jiti.import("@/lib/i18n/registry");
const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node, matches) {
  if (matches(node)) return node;
  return ts.forEachChild(node, (child) => find(child, matches));
}
function compile(expression) {
  assert.ok(expression, "actual component expression exists");
  return new Script(ts.transpileModule(`(${expression.getText(source)})`, {
    fileName: "reasoning-menu.tsx",
    compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText);
}
// Execute the whole real control, not just its inner map: this catches a binary
// model accidentally excluded by a parent condition, or a duplicate toolbar action.
const control = compile(find(source, (node) => ts.isJsxExpression(node)
  && node.expression?.getText(source).startsWith('onThinkingLevelChange && thinkingMode !== "none"')).expression);
const initializers = Object.fromEntries([
  "THINKING_LEVEL_DESC_KEYS", "resolvedThinkingLevel", "effectiveThinkingLevel", "toggleSupported",
  "thinkingControl", "thinkingMode", "hasThinkingToggle", "thinkingToggleOn", "thinkingDisplayLabel",
  "thinkingTriggerLabel", "selectThinkingLevel",
].map((name) => [name, compile(find(source, (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name).initializer)]));
const qwen = ["off", "low", "medium", "xhigh"];

function harness({ current = "xhigh", saved = null, levels = qwen, toggle = true, levelMap = null,
  auto = false, openInitially = true, canSave = true, isStreaming = false, locale = "en" } = {}) {
  const calls = [];
  let open = openInitially;
  const context = {
    React, SelectorRow, isMobile: false, controlsMenuOpen: false, isStreaming,
    t: (name) => getLocalePlugin(locale).messages[name] ?? name,
    thinkingDropdownRef: { current: null }, thinkingDropdownOpen: open,
    thinkingControlState, defaultThinkingLevelFor,
    thinkingLevel: current, availableThinkingLevels: levels,
    model: { provider: "test", modelId: "capability-test" },
    modelList: [{ provider: "test", id: "capability-test", thinkingToggle: toggle }],
    thinkingLevelMap: levelMap, isAutoThinkingSelection: auto, savedDefaultThinkingLevel: saved,
    setThinkingDropdownOpen(next) { open = typeof next === "function" ? next(open) : next; },
    onThinkingLevelChange(level) { calls.push(["select", level]); },
    onSetDefaultThinkingLevel: canSave ? (level) => calls.push(["save", level]) : undefined,
  };
  for (const [name, script] of Object.entries(initializers)) context[name] = script.runInNewContext(context);
  const element = control.runInNewContext(context);
  assert.ok(React.isValidElement(element));
  const children = React.Children.toArray(element.props.children);
  const buttons = children.filter((child) => child.type === "button");
  assert.equal(buttons.length, 1, "only one reasoning trigger, no bulb toggle or toolbar star");
  const menu = children.find((child) => child.props.role === "listbox");
  const rows = menu ? React.Children.toArray(menu.props.children) : [];
  const row = (level) => rows.find((entry) => entry.key.endsWith(`$${level}`));
  const rowLevels = () => rows.map((entry) => entry.key.split("$").at(-1));
  const html = () => renderToStaticMarkup(React.createElement(I18nProvider, null, element));
  const rowText = (level) => renderToStaticMarkup(React.createElement(I18nProvider, null, row(level))).replace(/<[^>]*>/g, "");
  const rowColumns = (level) => React.Children.toArray(row(level).props.children)
    .map((column) => renderToStaticMarkup(column).replace(/<[^>]*>/g, ""));
  return { calls, rows, row, rowLevels, rowText, rowColumns, html, menu, triggerLabel: context.thinkingTriggerLabel,
    isOpen: () => open, clickTrigger: buttons[0].props.onClick };
}

test("Qwen's unified menu has contiguous off/efforts with truthful active rows and per-option stars", () => {
  for (const current of qwen) {
    for (const isStreaming of [false, true]) {
      const h = harness({ current, saved: "low", levelMap: { off: "none" }, isStreaming });
      assert.deepEqual(h.rowLevels(), qwen);
      assert.equal(React.Children.count(h.menu.props.children), 4, "no divider or extra row");
      assert.equal(h.row("off").props.star.isDefault, false);
      assert.equal(h.row("low").props.star.isDefault, true);
      assert.deepEqual(h.rows.filter((row) => row.props.active).map((row) => row.key.split("$").at(-1)), [current]);
      assert.deepEqual(h.calls, [], "opening/rendering changes neither selection nor default");
      assert.deepEqual(h.rowColumns("off"), ["off", "Reasoning off"], "off uses separate value/description columns, never the internal none marker");
      const html = h.html();
      assert.match(html, /role="listbox"/);
      assert.equal([...html.matchAll(/aria-selected="true"/g)].length, 1);
      assert.match(html, /aria-label="Default reasoning level for this model"/);
      assert.match(html, /aria-label="Use and save as this model&#x27;s default reasoning level"/);
      assert.doesNotMatch(html, /role="separator"|<hr/);
    }
  }
});

test("native off default has its own Qwen menu star, independently of the active selection", () => {
  for (const current of ["off", "xhigh"]) {
    const h = harness({ current, saved: "off" });
    assert.equal(h.row("off").props.active, current === "off");
    assert.equal(h.row("off").props.star.isDefault, true);
    assert.equal(h.rows.filter((row) => row.props.star?.isDefault).length, 1);
    assert.match(h.html(), /aria-label="Default reasoning level for this model"/);
    assert.deepEqual(h.calls, []);
  }
});

test("the actual unified trigger opens while off without enabling reasoning or saving defaults", () => {
  for (const levels of [qwen, ["off", "medium"]]) {
    const h = harness({ current: "off", levels, openInitially: false });
    assert.equal(h.menu, undefined);
    h.clickTrigger();
    assert.equal(h.isOpen(), true);
    h.clickTrigger();
    assert.equal(h.isOpen(), false);
    assert.deepEqual(h.calls, []);
  }
});

test("Qwen selections send the actual off/effort value and close, without writing defaults", () => {
  for (const current of qwen) {
    for (const next of qwen) {
      for (const auto of [false, true]) {
        const h = harness({ current, auto });
        h.row(next).props.onSelect();
        assert.deepEqual(h.calls, current !== next || auto ? [["select", next]] : []);
        assert.equal(h.isOpen(), false);
      }
    }
  }
});

test("Qwen menu saves off and every effort, closing without a second select callback", () => {
  for (const current of ["off", "medium"]) {
    for (const effort of qwen) {
      const h = harness({ current });
      h.row(effort).props.star.onSave();
      assert.deepEqual(h.calls, [["save", effort]]);
      assert.equal(h.isOpen(), false);
    }
    const noSave = harness({ current, canSave: false });
    assert.equal(noSave.rows.some((row) => row.props.star), false);
    assert.doesNotMatch(noSave.html(), /<polygon/);
  }
});

test("Gemma has only on/off with menu stars and sends the real internal enabled marker", () => {
  for (const marker of ["medium", "xhigh"]) {
    for (const current of ["off", marker]) {
      for (const saved of [null, "off", marker]) {
        const h = harness({ levels: ["off", marker], current, saved, levelMap: { off: "none", [marker]: "internal" } });
        assert.deepEqual(h.rowLevels(), [marker, "off"]);
        assert.deepEqual(h.rowColumns(marker), ["Reasoning on"]);
        assert.deepEqual(h.rowColumns("off"), ["Reasoning off"]);
        assert.equal(h.rowText("off"), "Reasoning off");
        assert.equal(h.row(current).props.active, true);
        assert.equal(h.rows.every((row) => row.props.star && row.props.gutter), true);
        assert.equal(h.rows.filter((row) => row.props.star.isDefault).length, saved === null ? 0 : 1);
        if (saved !== null) assert.equal(h.row(saved).props.star.isDefault, true);
        assert.doesNotMatch(h.html(), /internal|>medium</);
        const next = current === "off" ? marker : "off";
        h.row(next).props.onSelect();
        assert.deepEqual(h.calls, [["select", next]]);
        assert.equal(h.isOpen(), false);
      }
    }
  }
});

test("Gemma can save either on or off from its menu without a separate select callback", () => {
  for (const level of ["medium", "off"]) {
    const h = harness({ levels: ["off", "medium"], current: level === "off" ? "medium" : "off" });
    h.row(level).props.star.onSave();
    assert.deepEqual(h.calls, [["save", level]]);
    assert.equal(h.isOpen(), false);
    const noSave = harness({ levels: ["off", "medium"], current: level, canSave: false });
    assert.equal(noSave.rows.some((row) => row.props.star), false);
    assert.doesNotMatch(noSave.html(), /<polygon/);
  }
});

test("ordinary GPT-style menus retain supported off and its selection/default star", () => {
  const levels = ["off", "low", "medium", "high", "xhigh", "max"];
  const h = harness({ levels, toggle: false, current: "high", saved: "high" });
  assert.deepEqual(h.rowLevels(), levels);
  assert.equal(h.row("high").props.active, true);
  assert.equal(h.row("high").props.star.isDefault, true);
  h.row("off").props.onSelect();
  assert.deepEqual(h.calls, [["select", "off"]]);
  const disabled = harness({ levels, toggle: false, current: "off", saved: "off" });
  assert.equal(disabled.row("off").props.active, true);
  assert.equal(disabled.row("off").props.star.isDefault, true);
  const save = harness({ levels, toggle: false, current: "high" });
  save.row("off").props.star.onSave();
  assert.deepEqual(save.calls, [["save", "off"]]);
});

test("actual unified labels reuse all existing translations, including binary menu rows", () => {
  // I18nProvider SSR always uses English; execute the real label initializers
  // with each registered dictionary rather than pretend SSR hydrated a locale.
  for (const [locale, effort, off, on] of [
    ["en", "Reasoning · low", "Reasoning off", "Reasoning on"],
    ["zh-CN", "推理 · low", "关闭推理", "开启推理"],
    ["zh-TW", "推理 · low", "關閉推理", "開啟推理"],
  ]) {
    assert.equal(harness({ current: "low", locale }).triggerLabel, effort);
    assert.equal(harness({ current: "off", locale }).triggerLabel, off);
    const binary = harness({ levels: ["off", "medium"], current: "medium", locale });
    assert.equal(binary.triggerLabel, on);
    assert.equal(binary.rowText("medium"), on);
    assert.deepEqual(binary.rowColumns("medium"), [on]);
    assert.deepEqual(binary.rowColumns("off"), [off]);
    assert.deepEqual(harness({ current: "off", locale }).rowColumns("off"), ["off", off]);
  }
});

test("actual menus never invent unsupported off even when the transport has a toggle capability", () => {
  for (const toggle of [false, true]) {
    const levels = ["low", "medium", "xhigh"];
    const h = harness({ levels, toggle, current: "medium", saved: "medium" });
    assert.deepEqual(h.rowLevels(), levels);
    assert.equal(h.row("off"), undefined);
    assert.equal(h.row("medium").props.active, true);
    assert.equal(h.row("medium").props.star.isDefault, true);
  }
});
