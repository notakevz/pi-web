import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionServices, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const { createLocalSubagentServices } = await createJiti(import.meta.url).import("./local-subagent-services.ts");

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "local-subagent-services-"));
  const agentDir = join(dir, "agent"), cwd = join(dir, "project");
  await mkdir(agentDir); await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  return { dir, cwd, agentDir, modelRuntime };
}

const noResources = { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true };

test("limited loader isolates settings; noExtensions alone still invokes the configured installer (offline control)", async (t) => {
  const f = await fixture(t);
  const calls = join(f.dir, "npm-calls"), recorder = join(f.dir, "npm.cjs");
  await writeFile(recorder, `require('fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(1);`);
  const settingsFile = join(f.agentDir, "settings.json");
  const source = JSON.stringify({ packages: ["npm:offline-fixture@file:/nonexistent-offline-fixture"],
    npmCommand: [process.execPath, recorder], defaultThinkingLevel: "low", shellPath: "/fixture/shell",
    enabledModels: ["fixture/*"], retry: { enabled: false } });
  await writeFile(settingsFile, source);
  const settingsManager = SettingsManager.create(f.cwd, f.agentDir);
  const policy = { version: 1, mode: "plan", scope: "global", role: "scout", sourcePath: join(f.agentDir, "agents", "scout.md"), builtins: ["read", "grep", "find", "ls"], webfetch: false };
  const options = { ...f, settingsManager, resourceLoaderOptions: noResources };
  const services = await createLocalSubagentServices(options, policy);
  assert.equal(services.settingsManager, settingsManager, "session keeps the original manager, not a sanitized copy");
  assert.equal(services.settingsManager.getDefaultThinkingLevel(), "low");
  assert.equal(services.settingsManager.getShellPath(), "/fixture/shell");
  assert.deepEqual(services.settingsManager.getEnabledModels(), ["fixture/*"]);
  assert.equal(services.settingsManager.getRetrySettings().enabled, false);
  await services.resourceLoader.reload();
  assert.equal(existsSync(calls), false);
  assert.deepEqual(services.resourceLoader.getExtensions().extensions, []);
  assert.equal(await readFile(settingsFile, "utf8"), source);

  // SDK 1.5 still attempts installation under noExtensions, but reports its
  // failure as a warning instead of rejecting startup. Keep the offline
  // positive control: the limited loader above must never invoke this recorder.
  const original = await createAgentSessionServices(options);
  assert.ok(original.resourceLoader.getExtensions().warnings.some((item) =>
    item.path.includes("offline-fixture") && /failed with code 1/.test(item.warning)));
  assert.match(await readFile(calls, "utf8"), /install.*offline-fixture/);
  assert.equal(await readFile(settingsFile, "utf8"), source);
});

test("without a local policy, normal configured extension loading remains unchanged", async (t) => {
  const f = await fixture(t);
  const extension = join(f.agentDir, "normal.ts");
  await writeFile(extension, `export default (pi) => { pi.registerCommand('normal-command', { description: 'normal', handler: async () => {} }); };`);
  const settingsManager = SettingsManager.inMemory({ extensions: [extension] });
  const services = await createLocalSubagentServices({ ...f, settingsManager });
  assert.equal(services.settingsManager, settingsManager);
  assert.ok(services.resourceLoader.getExtensions().extensions.some((item) => item.commands.has("normal-command")));
  await services.resourceLoader.reload();
  assert.ok(services.resourceLoader.getExtensions().extensions.some((item) => item.commands.has("normal-command")));
});
