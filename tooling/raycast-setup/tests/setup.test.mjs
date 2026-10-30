import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  cp,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import local from "../../../shared/local-config.js";
import { Manager } from "../manager.mjs";
import { save, json, remove } from "../io.mjs";
import { inventory, snapshot } from "../snapshot.mjs";
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "raycast-ø- "));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, "flyttet prosjekt"),
    root = join(base, "state"),
    target = join(base, "installed");
  for (const dir of [
    "shared",
    "tooling",
    "bin",
    "extensions/todoist",
    "extensions/local-search",
    "script-commands",
  ]) {
    await mkdir(join(repo, dir), { recursive: true });
    await writeFile(join(repo, dir, "source.txt"), "v1");
  }
  const config = {
    version: 1,
    repositoryPath: repo,
    components: ["todoist", "local-search", "scripts"],
    raycastTarget: "release",
  };
  const host = {
    busy: false,
    fail: false,
    validations: 0,
    async validate() {
      this.validations++;
      if (this.invalid) throw new Error("test failed");
    },
    async canActivate(versions) {
      return !this.busy && versions.includes(this.version || 2);
    },
    async backup(c, directory) {
      await mkdir(directory, { recursive: true });
      const value = await readFile(join(target, c), "utf8").catch(() => null);
      await save(join(directory, "backup.json"), { value });
      return { component: c, directory, files: [], value };
    },
    async activate(c) {
      await mkdir(target, { recursive: true });
      await writeFile(join(target, c), "installed");
      if (this.fail && c === "local-search")
        throw new Error("activation failed");
    },
    async restore(item) {
      if (this.restoreFail) throw new Error("restore failed");
      if (item.value === null)
        await rm(join(target, item.component), { force: true });
      else await writeFile(join(target, item.component), item.value);
    },
    async backupLegacy() {
      return { file: "legacy" };
    },
    async stopLegacy() {
      this.stopped = true;
    },
    async restoreLegacy() {
      this.stopped = false;
    },
  };
  return {
    repo,
    root,
    target,
    config,
    host,
    manager: new Manager(config, root, host),
  };
}
test("configuration: new home, invalid version, absolute paths and selected components", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(local.readLocalConfig(f.root), {});
  await save(local.configPath(f.root), {
    ...f.config,
    libraryPath: "relative",
  });
  assert.throws(() => local.readLocalConfig(f.root));
  await save(local.configPath(f.root), {
    ...f.config,
    libraryPath: join(f.root, "æ ø"),
  });
  assert.equal(local.readLocalConfig(f.root).libraryPath, join(f.root, "æ ø"));
});
test("snapshot includes new files and native focus sources, excludes secrets and generated files", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.repo, "shared/native/focus-panel"), { recursive: true });
  await writeFile(join(f.repo, "shared/native/focus-panel/a.swift"), "source");
  await writeFile(join(f.repo, "shared/.env"), "secret");
  const out = join(f.repo, "copy");
  await snapshot(f.repo, out, ["shared"]);
  const files = await inventory(join(out, "shared"));
  assert.ok(files["native/focus-panel/a.swift"]);
  assert.ok(!files[".env"]);
});
test("snapshot rejects links outside sources", async (t) => {
  const f = await fixture(t);
  await symlink("/tmp", join(f.repo, "shared/link"));
  await assert.rejects(
    snapshot(f.repo, join(f.repo, "copy"), ["shared"]),
    /lenke/,
  );
});
test("check never activates and removes work", async (t) => {
  const f = await fixture(t);
  await f.manager.check();
  assert.equal(await json(join(f.root, "state.json"), null), null);
  assert.equal(f.host.stopped, undefined);
});
test("idempotent update and local uncommitted changes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.manager.update()).result, "installed");
  assert.equal((await f.manager.update()).result, "unchanged");
  await writeFile(join(f.repo, "extensions/local-search/new.ts"), "new");
  assert.deepEqual((await f.manager.update()).changed, ["local-search"]);
});
test("shared changes invalidate all components", async (t) => {
  const f = await fixture(t);
  await f.manager.update();
  await writeFile(join(f.repo, "shared/source.txt"), "v2");
  assert.equal((await f.manager.status()).changed.length, 3);
});
test("failed validation leaves installed version intact", async (t) => {
  const f = await fixture(t);
  await f.manager.update();
  const before = await json(join(f.root, "state.json"));
  f.host.invalid = true;
  await writeFile(join(f.repo, "shared/source.txt"), "v2");
  await assert.rejects(f.manager.update(), /test failed/);
  assert.deepEqual(await json(join(f.root, "state.json")), before);
});
test("partial activation restores all code and legacy service", async (t) => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(join(f.target, "todoist"), "old");
  f.host.fail = true;
  await assert.rejects(f.manager.update(), /activation failed/);
  assert.equal(await readFile(join(f.target, "todoist"), "utf8"), "old");
  await assert.rejects(readFile(join(f.target, "local-search")));
  assert.equal(f.host.stopped, false);
  assert.equal((await json(join(f.root, "journal.json"))).phase, "restored");
});
test("busy focus preserves candidate, reuses it on next update", async (t) => {
  const f = await fixture(t);
  f.host.busy = true;
  assert.equal((await f.manager.update()).result, "deferred");
  const n = f.host.validations;
  f.host.busy = false;
  assert.equal((await f.manager.update()).result, "installed");
  assert.equal(f.host.validations, n);
});
test("incompatible focus version prevents activation", async (t) => {
  const f = await fixture(t);
  f.host.version = 3;
  assert.equal((await f.manager.update()).result, "deferred");
});
test("offline rollback restores previous code without validation", async (t) => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(join(f.target, "todoist"), "old");
  await f.manager.update();
  f.host.invalid = true;
  assert.equal((await f.manager.rollback()).result, "rolled-back");
  assert.equal(await readFile(join(f.target, "todoist"), "utf8"), "old");
});
test("live lock rejects concurrent operation", async (t) => {
  const f = await fixture(t);
  await f.manager.initialize();
  await save(join(f.root, "operation.lock"), { pid: process.pid });
  await assert.rejects(f.manager.update(), /annen/);
});
test("candidate focus compatibility comes from its source and rollback retains old limits", async (t) => {
  const f = await fixture(t);
  await f.manager.update();
  await save(
    join(f.repo, "extensions/todoist/focus-state-versions.json"),
    [1, 2, 3],
  );
  await f.manager.update();
  assert.deepEqual(
    (await json(join(f.root, "state.json"))).focusVersions,
    [1, 2, 3],
  );
  f.host.version = 3;
  await assert.rejects(f.manager.rollback(), /fokus|kompatib/i);
});
test("unknown focus compatibility metadata fails without activation", async (t) => {
  const f = await fixture(t);
  await save(join(f.repo, "extensions/todoist/focus-state-versions.json"), [
    1,
    "3",
  ]);
  await assert.rejects(f.manager.update(), /kompatibilitetsliste/);
  assert.equal(await json(join(f.root, "state.json"), null), null);
});
test("interrupted transaction recovers on next operation", async (t) => {
  const f = await fixture(t);
  await mkdir(f.target);
  await writeFile(join(f.target, "todoist"), "partial");
  await f.manager.initialize();
  await save(join(f.root, "journal.json"), {
    phase: "activating",
    before: { hashes: {} },
    items: [{ component: "todoist", value: "old" }],
    legacy: null,
  });
  await f.manager.locked(async () => {});
  assert.equal(await readFile(join(f.target, "todoist"), "utf8"), "old");
});
test("cleanup preserves current and previous and rejects symlinks", async (t) => {
  const f = await fixture(t);
  await f.manager.update();
  const state = await json(join(f.root, "state.json"));
  await mkdir(join(f.root, "releases/unused"));
  await save(join(f.root, "releases/unused/owner.json"), {
    owner: "PersonalRaycast",
  });
  assert.ok(
    (await f.manager.clean(true)).deleted.some((x) => x.endsWith("unused")),
  );
  await f.manager.clean(false);
  await readFile(join(f.root, "releases", state.id, "release.json"));
  await symlink("/tmp", join(f.root, "releases/foreign"));
  await assert.rejects(f.manager.clean(false), /lenke/);
  await assert.rejects(remove(f.root, f.repo), /utenfor/);
});

test("cleanup rejects directories with no ownership marker", async (t) => {
  const f = await fixture(t);
  await f.manager.update();
  await mkdir(join(f.root, "releases/user-created"));
  await assert.rejects(f.manager.clean(false), /Fremmed/);
});
test("candidate cannot change after validation while focus is busy", async (t) => {
  const f = await fixture(t);
  f.host.busy = true;
  await f.manager.update();
  const pending = await json(join(f.root, "pending.json"));
  await writeFile(join(pending.folder, "shared/source.txt"), "changed");
  f.host.busy = false;
  await assert.rejects(f.manager.update(), /Kandidaten/);
});
test("real host scripts installation is executable from retained release and preserves foreign scripts on failure", async (t) => {
  const f = await fixture(t);
  const { Host } = await import("../host.mjs");
  const host = new Host(f.config, f.root, dirname(f.root));
  const dir = join(f.repo, "script-commands");
  await writeFile(
    join(dir, "open.sh"),
    '#!/bin/sh\n# Managed by PersonalRaycast\nbase="old"\nexec "$base/bin/raycast-setup" status\n',
  );
  const backup = await host.backup("scripts", join(f.root, "backup"));
  await host.activate("scripts", f.repo);
  const script = await readFile(
    join(host.target("scripts"), "open.sh"),
    "utf8",
  );
  assert.ok(script.includes("/releases/"));
  await writeFile(join(host.target("scripts"), "open.sh"), "# user script");
  await assert.rejects(host.activate("scripts", f.repo), /Fremmed/);
  await host.restore(backup);
  await assert.rejects(readFile(join(host.target("scripts"), "open.sh")));
});

test("command runner enforces timeout and stops its own process", async (t) => {
  const f = await fixture(t);
  const { Host } = await import("../host.mjs");
  const host = new Host(f.config, f.root, dirname(f.root));
  await assert.rejects(
    host.run(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      f.repo,
      join(f.root, "timeout.log"),
      100,
    ),
    /tidsgrensen/,
  );
});
test("configuration rejects credentials and invalid targets", async (t) => {
  const f = await fixture(t);
  assert.throws(() =>
    local.validateConfig({ ...f.config, token: "synthetic" }),
  );
  assert.throws(() =>
    local.validateConfig({ ...f.config, raycastTarget: "unknown" }),
  );
});

test("activation retains a stable source directory and removes temporary dependency link", async (t) => {
  const f = await fixture(t);
  const { Host } = await import("../host.mjs");
  const host = new Host(
    { ...f.config, nodePath: process.execPath },
    f.root,
    dirname(f.root),
  );
  const source = join(f.repo, "extensions/todoist");
  const cli = join(source, "node_modules/@raycast/api/bin/run.js");
  await mkdir(dirname(cli), { recursive: true });
  await mkdir(host.target("todoist"), { recursive: true });
  await writeFile(join(host.target("todoist"), "package.json"), "{}");
  await writeFile(
    cli,
    `console.log('built extension successfully'); setInterval(()=>{},1000);`,
  );
  await host.activate("todoist", f.repo);
  const retained = join(
    f.root,
    "releases",
    f.repo.split("/").at(-1),
    "source/extensions/todoist",
  );
  assert.equal(await readFile(join(retained, "source.txt"), "utf8"), "v1");
  await assert.rejects(
    readFile(join(retained, "node_modules/@raycast/api/bin/run.js")),
  );
});
