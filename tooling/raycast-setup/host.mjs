import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  readdir,
  lstat,
  cp,
  rm,
  readFile,
  writeFile,
  rename,
  statfs,
  symlink,
} from "node:fs/promises";
import { join, dirname, basename, relative } from "node:path";
import { json, save, safePath } from "./io.mjs";
const exec = promisify(execFile),
  LIMIT = 10 * 1024 * 1024;
export class Host {
  constructor(config, root, home) {
    this.config = config;
    this.root = root;
    this.home = home;
  }
  target(c) {
    return c === "scripts"
      ? join(this.root, "commands")
      : join(
          this.home,
          ".config",
          this.config.raycastTarget === "x" ? "raycast-x" : "raycast",
          "extensions",
          c,
        );
  }
  async run(file, args, cwd, log, timeout = 600000) {
    await mkdir(dirname(log), { recursive: true });
    return new Promise((yes, no) => {
      const child = spawn(file, args, {
        cwd,
        env: {
          ...process.env,
          CI: "true",
          FOCUS_PANEL_BUILD_DIR: join(cwd, "work/focus-panel-build"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let output = Buffer.alloc(0),
        done = false,
        timedOut = false,
        escalation;
      const append = (data) => {
        output = Buffer.concat([output, data]);
        if (output.length > LIMIT)
          output = output.subarray(output.length - LIMIT);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => {
        timedOut = true;
        escalation = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 3000);
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }, timeout);
      const finish = async (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(escalation);
        try {
          await writeFile(log, output, { mode: 0o600 });
        } catch (failure) {
          no(failure);
          return;
        }
        if (timedOut)
          error = new Error("Kontrollen nådde tidsgrensen. Se " + log);
        error ? no(error) : yes(output.toString());
      };
      child.on("error", (e) => void finish(e));
      child.on(
        "close",
        (code) =>
          void finish(
            code === 0
              ? null
              : new Error(`Kontroll feilet: ${args.join(" ")}. Se ${log}`),
          ),
      );
    });
  }
  async validate(folder, changed, report) {
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw new Error("Node 24 eller nyere kreves.");
    for (const [key, flag] of [
      ["nodePath", "--version"],
      ["pythonPath", "--version"],
    ]) {
      const r = await exec(this.config[key], [flag]);
      report[key] = r.stdout.trim();
    }
    if (Number(report.nodePath.replace(/^v/, "").split(".")[0]) < 24)
      throw new Error("Den konfigurerte Node-versjonen må være minst 24.");
    for (const [key, script] of [
      ["atlasPath", "scripts/atlas-control.ts"],
      ["libraryPath", "control.py"],
    ]) {
      if (
        this.config[key] &&
        this.config.components.some((c) =>
          ["scripts", "local-search"].includes(c),
        )
      )
        await access(join(this.config[key], script));
    }
    for (const key of ["rm2Path", "pdfinfoPath", "pdftoppmPath"])
      if (this.config[key]) await access(this.config[key]);
    const npm = join(dirname(this.config.nodePath), "npm");
    const run = async (c, args) => {
      const log = join(
        this.root,
        "reports",
        report.id + "-" + c + "-" + report.checks.length + ".log",
      );
      await this.run(npm, args, join(folder, "extensions", c), log);
      report.checks.push({ component: c, args, log, result: "passed" });
    };
    await this.run(
      this.config.nodePath,
      [
        "--test",
        "--test-concurrency=1",
        "tooling/raycast-setup/tests/setup.test.mjs",
      ],
      folder,
      join(this.root, "reports", report.id + "-manager.log"),
    );
    for (const c of changed.filter((c) => c !== "scripts")) {
      if (c === "todoist") {
        const space = await statfs(folder);
        if (Number(space.bavail) * Number(space.bsize) < 3 * 1024 ** 3)
          throw new Error("For lite diskplass til isolert bygg.");
      }
      await run(c, ["ci", "--no-audit", "--no-fund"]);
      await run(
        c,
        c === "local-search" ? ["test"] : ["test", "--", "--maxWorkers=1"],
      );
      await run(c, ["run", "lint"]);
      // Build generates Raycast declarations, then checks TypeScript.
      if (c === "todoist") await run(c, ["run", "test:focus"]);
      await run(c, ["run", "build"]);
      await run(c, ["run", "typecheck"]);
    }
  }
  async canActivate(versions) {
    const processes = (
      await exec("/bin/ps", ["-axo", "command="], {
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
    if (processes.split("\n").some((line) => /\/FocusPanel(?:\s|$)/.test(line)))
      return false;
    const marker = await json(join(this.root, "focus-location.json"), {});
    const file =
      this.config.focusStatePath ||
      (marker.directory && join(marker.directory, "state.json"));
    if (!file) return true;
    const state = await json(file, null);
    if (!state) return true;
    if (!versions.includes(state.version)) return false;
    return (
      !["running", "paused"].includes(state.session?.phase) &&
      !state.tracking?.takeover &&
      !(state.tracking?.periods || []).some(
        (p) =>
          !["local", "synced", "accepted"].includes(p.sync) ||
          p.recoveryDetectedAt != null,
      )
    );
  }
  async backup(c, directory) {
    const target = this.target(c);
    await mkdir(directory, { recursive: true });
    const files = [];
    try {
      if ((await lstat(target)).isSymbolicLink())
        throw new Error("Installeringsmål er en symbolsk lenke.");
      for (const name of await readdir(target))
        if (!["cli.pid", "dev.log"].includes(name)) {
          const source = await safePath(target, join(target, name));
          await cp(source, join(directory, name), {
            recursive: true,
            dereference: false,
          });
          files.push(name);
        }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const state = await json(join(this.root, "state.json"), {});
    const sourcePath = state.id
      ? join(this.root, "releases", state.id, "source", "extensions", c)
      : join(this.config.repositoryPath, "extensions", c);
    return {
      component: c,
      directory,
      files,
      existed: files.length > 0,
      sourcePath,
    };
  }
  async idle(c) {
    if (c === "scripts") return;
    const file = join(this.target(c), "cli.pid"),
      value = await json(file, null);
    // CLI stores a bare PID, which is valid JSON. Never invoke develop against an unrelated watcher.
    if (Number.isInteger(value)) {
      try {
        process.kill(value, 0);
      } catch (e) {
        if (e.code === "ESRCH") {
          await rm(file, { force: true });
          return;
        }
        throw e;
      }
      throw new Error(
        `En utviklingsprosess bruker ${c}. Oppdateringen er utsatt.`,
      );
    }
  }
  async activate(c, folder) {
    if (c === "scripts") {
      await mkdir(this.target(c), { recursive: true });
      for (const name of await readdir(join(folder, "script-commands"))) {
        if (!name.endsWith(".sh")) continue;
        const dest = join(this.target(c), name);
        try {
          const old = await readFile(dest, "utf8");
          if (
            !old.includes("PersonalRaycast") &&
            !old.includes("Managed by Turatlas")
          )
            throw new Error(`Fremmed skript beholdt: ${name}`);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        const source = await readFile(
          join(folder, "script-commands", name),
          "utf8",
        );
        const base = join(this.root, "releases", basename(folder));
        const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
        await writeFile(
          dest,
          source.replace(/^base=.*$/m, "base=" + quote(base)),
          { mode: 0o755 },
        );
      }
      return;
    }
    await this.idle(c);
    const source = join(folder, "extensions", c);
    const retained = join(this.root, "releases", basename(folder), "source");
    const cwd = join(retained, "extensions", c);
    await cp(source, cwd, {
      recursive: true,
      filter: (file) =>
        !relative(source, file)
          .split("/")
          .some((part) => ["node_modules", "work", "dist"].includes(part)),
    });
    await cp(join(folder, "shared"), join(retained, "shared"), {
      recursive: true,
    });
    const dependencies = join(cwd, "node_modules");
    await symlink(join(source, "node_modules"), dependencies, "dir");
    const cli = join(dependencies, "@raycast/api/bin/run.js");
    try {
      await new Promise((yes, no) => {
        const child = spawn(
          this.config.nodePath,
          [
            cli,
            "develop",
            "--non-interactive",
            "--target",
            this.config.raycastTarget,
          ],
          { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true },
        );
        let tail = "",
          ready = false,
          failure = null,
          stopped = false,
          escalation;
        const stop = (error) => {
          failure ||= error;
          if (stopped) return;
          stopped = true;
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {}
          escalation = setTimeout(() => {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }, 3000);
        };
        const timer = setTimeout(
          () => stop(new Error("Raycast-aktivering nådde tidsgrensen.")),
          120000,
        );
        child.on("error", (error) => {
          clearTimeout(timer);
          clearTimeout(escalation);
          no(error);
        });
        const output = (data) => {
          tail = (tail + data.toString()).slice(-32768);
          if (/cannot notify Raycast|Raycast is not running/.test(tail))
            stop(new Error("Raycast-registrering er ikke bekreftet."));
          if (tail.includes("built extension successfully") && !ready) {
            ready = true;
            setTimeout(() => stop(null), 750);
          }
        };
        child.stdout.on("data", output);
        child.stderr.on("data", output);
        child.on("close", (code) => {
          clearTimeout(timer);
          clearTimeout(escalation);
          failure
            ? no(failure)
            : ready
              ? yes()
              : no(new Error(`Raycast-aktivering feilet (${code}).`));
        });
      });
      await access(join(this.target(c), "package.json"));
    } finally {
      await rm(dependencies, { force: true });
    }
  }
  async restore(item) {
    const target = this.target(item.component);
    await mkdir(target, { recursive: true });
    if ((await lstat(target)).isSymbolicLink())
      throw new Error("Installeringsmålet er endret til en lenke.");
    for (const name of await readdir(target))
      if (!["cli.pid", "dev.log"].includes(name))
        await rm(await safePath(target, join(target, name)), {
          recursive: true,
          force: true,
        });
    for (const name of item.files)
      await cp(join(item.directory, name), join(target, name), {
        recursive: true,
      });
    if (item.component !== "scripts" && item.existed) {
      const scheme =
        this.config.raycastTarget === "x" ? "raycast-x" : "raycast";
      await exec("/usr/bin/open", [
        "-g",
        `${scheme}://cli/${item.component}/build-success?cwd=${encodeURIComponent(item.sourcePath || this.config.repositoryPath + "/extensions/" + item.component)}`,
      ]);
    }
  }
  async backupLegacy(directory) {
    const file = join(
      this.home,
      "Library/LaunchAgents/local.raycast.todoist.dev.plist",
    );
    try {
      const text = await readFile(file, "utf8");
      if (!text.includes(this.config.repositoryPath + "/extensions/todoist"))
        throw new Error("Todoist-tjenesten tilhører en annen prosjektmappe.");
      const dest = join(directory, "legacy.plist");
      await writeFile(dest, text, { mode: 0o600 });
      const loaded = await exec("/bin/launchctl", [
        "print",
        `gui/${process.getuid()}/local.raycast.todoist.dev`,
      ]).then(
        () => true,
        () => false,
      );
      return { file, backup: dest, loaded };
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async stopLegacy(legacy) {
    if (!legacy) return;
    if (legacy.loaded)
      await exec("/bin/launchctl", [
        "bootout",
        `gui/${process.getuid()}/local.raycast.todoist.dev`,
      ]);
    await rm(legacy.file);
  }
  async restoreLegacy(legacy) {
    await cp(legacy.backup, legacy.file);
    if (legacy.loaded)
      await exec("/bin/launchctl", [
        "bootstrap",
        `gui/${process.getuid()}`,
        legacy.file,
      ]);
  }
}
