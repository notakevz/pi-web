import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const parse = (path) => ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const source = parse("./AppShell.tsx");
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const title = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "windowTitle");
const effect = nodes.find((node) => ts.isCallExpression(node)
  && node.expression.getText(source) === "useEffect"
  && node.arguments[1]?.getText(source) === "[windowTitle]");
const script = new Script(ts.transpileModule(`const windowTitle = ${title.initializer.getText(source)};
(${effect.arguments[0].getText(source)})()`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);

test("layout metadata uses Pi for the page and Apple title, without renaming the PWA brand", () => {
  const layout = parse("../app/layout.tsx");
  const metadata = layout.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find((node) => node.name.getText(layout) === "metadata");
  const value = new Script(`(${metadata.initializer.getText(layout)})`).runInNewContext();
  assert.equal(value.title, "Pi");
  assert.equal(value.appleWebApp.title, "Pi");
  assert.equal(value.applicationName, "Pi Web");
  assert.equal(value.manifest, "/manifest.webmanifest");
});

test("AppShell keeps Pi in every project and retains its existing title observer", () => {
  for (const activeCwd of [null, "/project-a", "/different/project-b", "C:\\work\\project-c"]) {
    const document = { title: "Old workspace - Pi Web", head: {} };
    const observers = [];
    const cleanup = script.runInNewContext({
      activeCwd, document,
      MutationObserver: class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(head, options) { this.head = head; this.options = options; }
        disconnect() { this.disconnected = true; }
      },
    });
    const observer = observers[0];
    assert.equal(document.title, "Pi");
    assert.equal(observer.head, document.head);
    assert.equal(observer.options.subtree, true);
    // The old compiled patch did not target the extension setTitle handler.
    // AppShell already observed that write, so it restores its fixed title.
    document.title = "Extension title";
    observer.callback();
    assert.equal(document.title, "Pi");
    cleanup();
    assert.equal(observer.disconnected, true);
  }
});
