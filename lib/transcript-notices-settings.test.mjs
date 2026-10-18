import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A synchronous FIFO/device regression cannot be stopped by node:test's timer.
// Run it in a bounded child with a disposable home and no inherited data paths.
test("notices settings skip nonregular and oversized files without blocking, retaining fallback and cache refresh", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-notices-settings-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") };
  for (const key of Object.keys(env)) {
    if (key.startsWith("XDG_") || /SESSION.*(DIR|PATH|FILE|ID)/.test(key) || key === "PI_WEB_PASSWORD") delete env[key];
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { execFileSync } from "node:child_process";
    import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { createJiti } from "jiti";
    const agent = process.env.PI_CODING_AGENT_DIR;
    const cwd = join(process.env.HOME, "project");
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const jiti = createJiti(join(process.cwd(), "package.json"), { alias: { "@": process.cwd() } });
    const { readShowCacheMissNotices } = await jiti.import("./lib/transcript-notices-server.ts");
    const { PROJECT_SETTINGS_MAX_BYTES } = await jiti.import("./lib/regular-file.ts");
    const globalPath = join(agent, "settings.json");
    const projectPath = join(cwd, ".pi", "settings.json");
    const setting = (path, value) => writeFileSync(path, JSON.stringify({ showCacheMissNotices: value }));
    const clear = (path) => rmSync(path, { recursive: true, force: true });
    assert.equal(readShowCacheMissNotices(cwd), false);
    setting(globalPath, true);
    assert.equal(readShowCacheMissNotices(cwd), true);
    setting(projectPath, false);
    assert.equal(readShowCacheMissNotices(cwd), false);

    // Both scopes use the same safe reader. Replacing a previously cached file
    // with something unsafe must discard its value; the other scope still wins.
    for (const path of [projectPath, globalPath]) {
      if (path === globalPath) clear(projectPath);
      const fallback = path === projectPath;
      const check = (make) => {
        clear(path);
        make();
        assert.equal(readShowCacheMissNotices(cwd), fallback);
        clear(path);
        setting(path, !fallback);
        assert.equal(readShowCacheMissNotices(cwd), !fallback, "a valid replacement is re-read");
      };
      check(() => mkdirSync(path));
      check(() => writeFileSync(path, JSON.stringify({ showCacheMissNotices: !fallback, padding: "x".repeat(PROJECT_SETTINGS_MAX_BYTES) })));
      check(() => writeFileSync(path, "{"));
      check(() => setting(path, "not a boolean"));
      if (process.platform !== "win32") {
        check(() => execFileSync("mkfifo", [path]));
        check(() => symlinkSync("/dev/zero", path));
      }
      clear(path);
    }
    // Links to ordinary bounded files and the SDK's BOM behavior remain valid.
    const target = join(process.env.HOME, "valid.json");
    writeFileSync(target, "\\uFEFF" + JSON.stringify({ showCacheMissNotices: true }));
    symlinkSync(target, projectPath);
    assert.equal(readShowCacheMissNotices(cwd), true);
    clear(target);
    assert.equal(readShowCacheMissNotices(cwd), false, "dangling link falls back to default");
  `], { env, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
