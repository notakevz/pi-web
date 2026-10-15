import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const { getFileName } = await jiti.import("../lib/file-paths.ts");
const parse = (path) => ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const source = parse("./AppShell.tsx");
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const declarations = ["activeCwdName", "windowTitle"].map((name) => nodes.find((node) =>
  ts.isVariableDeclaration(node) && node.name.getText(source) === name)).filter(Boolean);
const effect = nodes.find((node) => ts.isCallExpression(node)
  && node.expression.getText(source) === "useEffect"
  && node.arguments[1]?.getText(source) === "[windowTitle]");
const script = new Script(ts.transpileModule(`${declarations.map((node) => `const ${node.getText(source)};`).join("\n")}
(${effect.arguments[0].getText(source)})()`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);

test("layout metadata retains the upstream Pi Web page, Apple title and PWA brand", () => {
  const layout = parse("../app/layout.tsx");
  const metadata = layout.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find((node) => node.name.getText(layout) === "metadata");
  const value = new Script(`(${metadata.initializer.getText(layout)})`).runInNewContext();
  assert.equal(value.title, "Pi Web");
  assert.equal(value.appleWebApp.title, "Pi Web");
  assert.equal(value.applicationName, "Pi Web");
  assert.equal(value.manifest, "/manifest.webmanifest");
});

test("AppShell uses the upstream project title and retains its existing title observer", () => {
  for (const [activeCwd, expectedTitle] of [
    [null, "Pi Web"],
    ["", "Pi Web"],
    ["/project-a", "project-a - Pi Web"],
    ["/different/project-b/", "project-b - Pi Web"],
    ["C:\\work\\project-c", "project-c - Pi Web"],
    ["/", "/ - Pi Web"],
  ]) {
    const document = { title: "Old workspace - Pi Web", head: {} };
    const observers = [];
    const cleanup = script.runInNewContext({
      activeCwd, getFileName, document,
      MutationObserver: class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(head, options) { this.head = head; this.options = options; }
        disconnect() { this.disconnected = true; }
      },
    });
    const observer = observers[0];
    assert.equal(document.title, expectedTitle);
    assert.equal(observer.head, document.head);
    assert.equal(observer.options.subtree, true);
    // Preserve upstream's observer behavior when an extension writes a title.
    document.title = "Extension title";
    observer.callback();
    assert.equal(document.title, expectedTitle);
    cleanup();
    assert.equal(observer.disconnected, true);
  }
});
