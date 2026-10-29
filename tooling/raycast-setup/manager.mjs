import {
  mkdir,
  lstat,
  readdir,
  readFile,
  rm,
  open,
  cp,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { snapshot, inventory, digest } from "./snapshot.mjs";
import { json, save, remove, safePath } from "./io.mjs";
export const components = [
  "todoist",
  "parallels-virtual-machines",
  "local-search",
  "scripts",
];
const entry = (c) => (c === "scripts" ? "script-commands" : `extensions/${c}`);
export class Manager {
  constructor(config, root, host) {
    this.config = config;
    this.root = root;
    this.host = host;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new Error("Oppsettområdet kan ikke være en symbolsk lenke.");
    await save(join(this.root, "owner.json"), {
      owner: "PersonalRaycast",
      version: 1,
    });
  }
  async locked(operation) {
    await this.initialize();
    const file = join(this.root, "operation.lock");
    let lock;
    try {
      lock = await open(file, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const prior = await json(file, {});
      if (!Number.isInteger(prior.pid))
        throw new Error("Uavklart operasjonslås.");
      try {
        process.kill(prior.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") {
          await rm(file);
          return this.locked(operation);
        }
        throw e;
      }
      throw new Error("En annen oppsetthandling kjører.");
    }
    try {
      await this.recover();
      return await operation();
    } finally {
      await lock.close();
      await rm(file, { force: true });
    }
  }
  async recover() {
    const journal = await json(join(this.root, "journal.json"), null);
    if (!journal || ["complete", "restored"].includes(journal.phase)) return;
    if (
      journal.items.some((item) => item.component === "todoist") &&
      !(await this.host.canActivate(journal.before.focusVersions || [1, 2]))
    )
      throw new Error(
        "Gjenoppretting venter på ledig fokushjelper og kompatible data.",
      );
    for (const item of [...journal.items].reverse())
      await this.host.restore(item);
    if (journal.legacy) await this.host.restoreLegacy(journal.legacy);
    await save(join(this.root, "state.json"), journal.before);
    journal.phase = "restored";
    await save(join(this.root, "journal.json"), journal);
  }
  async hashes(repository) {
    const common = digest({
      shared: await inventory(join(repository, "shared")),
      tool: await inventory(join(repository, "tooling")),
      bin: await inventory(join(repository, "bin")),
      config: this.config,
    });
    const result = {};
    for (const c of this.config.components)
      result[c] = digest({
        common,
        files: await inventory(join(repository, entry(c))),
      });
    return result;
  }
  async status() {
    const state = await json(join(this.root, "state.json"), { hashes: {} });
    const hashes = await this.hashes(this.config.repositoryPath);
    return {
      state,
      changed: this.config.components.filter(
        (c) => state.hashes[c] !== hashes[c],
      ),
      journal: await json(join(this.root, "journal.json"), null),
      overrides: Object.fromEntries(
        await Promise.all(
          ["todoist", "local-search"].map(async (name) => [
            name,
            await json(join(this.root, "overrides", name + ".json"), {
              message:
                "Ingen innstillingsrapport ennå; oppdateres ved neste bruk i Raycast.",
            }),
          ]),
        ),
      ),
    };
  }
  async prepare() {
    const id = randomUUID(),
      folder = join(this.config.repositoryPath, "work", "personal-raycast", id);
    await mkdir(folder, { recursive: true });
    await save(join(folder, "owner.json"), {
      owner: "PersonalRaycast",
      version: 1,
    });
    try {
      await snapshot(this.config.repositoryPath, folder, [
        "shared",
        "tooling",
        "bin",
        ...this.config.components.map(entry),
      ]);
      const hashes = await this.hashes(folder),
        prior = await json(join(this.root, "state.json"), { hashes: {} });
      const changed = this.config.components.filter(
        (c) => hashes[c] !== prior.hashes[c],
      );
      const report = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        hashes,
        changed,
        checks: [],
        node: process.version,
      };
      try {
        await this.host.validate(folder, changed, report);
        report.result = "passed";
      } catch (e) {
        report.result = "failed";
        report.error = e.message;
        throw e;
      } finally {
        await save(join(this.root, "reports", id + ".json"), report);
      }
      return { id, folder, hashes, changed, focusVersions: [1, 2] };
    } catch (e) {
      await remove(join(this.config.repositoryPath, "work"), folder);
      throw e;
    }
  }
  async check() {
    return this.locked(async () => {
      const candidate = await this.prepare();
      await remove(join(this.config.repositoryPath, "work"), candidate.folder);
      return { result: "passed", changed: candidate.changed };
    });
  }
  async update() {
    return this.locked(async () => {
      const pending = await json(join(this.root, "pending.json"), null);
      let candidate;
      if (
        pending &&
        digest(pending.hashes) ===
          digest(await this.hashes(this.config.repositoryPath))
      )
        candidate = pending;
      else {
        if (pending)
          await remove(
            join(this.config.repositoryPath, "work"),
            pending.folder,
          );
        candidate = await this.prepare();
      }
      if (
        digest(await this.hashes(candidate.folder)) !== digest(candidate.hashes)
      )
        throw new Error(
          "Kandidaten er endret etter kontroll. Kjør check på nytt.",
        );
      if (!candidate.changed.length) {
        await remove(
          join(this.config.repositoryPath, "work"),
          candidate.folder,
        );
        await rm(join(this.root, "pending.json"), { force: true });
        return { result: "unchanged" };
      }
      if (
        candidate.changed.includes("todoist") &&
        !(await this.host.canActivate(candidate.focusVersions))
      ) {
        await save(join(this.root, "pending.json"), candidate);
        return {
          result: "deferred",
          message:
            "Fokushjelperen arbeider eller har uavklart arbeid. Kandidaten beholdes til neste oppdatering.",
        };
      }
      const before = await json(join(this.root, "state.json"), { hashes: {} }),
        release = join(this.root, "releases", candidate.id);
      await mkdir(release, { recursive: true });
      await save(join(release, "owner.json"), {
        owner: "PersonalRaycast",
        version: 1,
      });
      const journal = { phase: "activating", before, items: [], legacy: null };
      await save(join(this.root, "journal.json"), journal);
      try {
        journal.legacy = await this.host.backupLegacy(release);
        await save(join(this.root, "journal.json"), journal);
        await this.host.stopLegacy(journal.legacy);
        for (const c of candidate.changed) {
          const item = await this.host.backup(c, join(release, c));
          journal.items.push(item);
          await save(join(this.root, "journal.json"), journal);
          await this.host.activate(c, candidate.folder);
        }
        const installed = {
          id: candidate.id,
          hashes: candidate.hashes,
          focusVersions: candidate.focusVersions,
          installedAt: new Date().toISOString(),
          previous: before.id || null,
        };
        await save(join(release, "release.json"), {
          ...installed,
          items: journal.items,
          legacy: journal.legacy,
          before,
        });
        // Retain dependency-free manager code for stable Script Commands.
        for (const part of ["tooling", "shared", "bin"])
          await cp(join(candidate.folder, part), join(release, part), {
            recursive: true,
          });
        await save(join(this.root, "state.json"), installed);
        journal.phase = "complete";
        await save(join(this.root, "journal.json"), journal);
        await rm(join(this.root, "pending.json"), { force: true });
        await remove(
          join(this.config.repositoryPath, "work"),
          candidate.folder,
        );
        return {
          result: "installed",
          id: installed.id,
          changed: candidate.changed,
        };
      } catch (e) {
        await this.recover();
        await remove(
          join(this.config.repositoryPath, "work"),
          candidate.folder,
        );
        throw e;
      }
    });
  }
  async rollback() {
    return this.locked(async () => {
      const state = await json(join(this.root, "state.json"), {});
      if (!state.id)
        throw new Error("Ingen administrert versjon å tilbakeføre.");
      const release = await json(
        join(this.root, "releases", state.id, "release.json"),
        null,
      );
      if (!release) throw new Error("Sikkerhetskopi mangler.");
      if (
        !(await this.host.canActivate(release.before.focusVersions || [1, 2]))
      )
        throw new Error("Fokusdata er i bruk eller inkompatible.");
      const journal = {
        phase: "rollback",
        before: state,
        items: [],
        legacy: null,
      };
      // Save the currently installed code so a failed rollback is itself reversible.
      const work = join(this.root, "recovery", randomUUID());
      await mkdir(work, { recursive: true });
      for (const item of release.items)
        journal.items.push(
          await this.host.backup(item.component, join(work, item.component)),
        );
      await save(join(this.root, "journal.json"), journal);
      try {
        for (const item of [...release.items].reverse())
          await this.host.restore(item);
        await save(join(this.root, "state.json"), release.before);
        journal.phase = "complete";
        await save(join(this.root, "journal.json"), journal);
        await remove(this.root, work);
        return { result: "rolled-back", id: release.before.id || null };
      } catch (e) {
        await this.recover();
        throw e;
      }
    });
  }
  async clean(dryRun = true) {
    return this.locked(async () => {
      const state = await json(join(this.root, "state.json"), {}),
        keep = new Set([state.id, state.previous].filter(Boolean)),
        deleted = [];
      for (const dir of ["releases", "reports"]) {
        const base = join(this.root, dir);
        await mkdir(base, { recursive: true });
        const files = await readdir(base);
        if (dir === "releases")
          for (const name of files) {
            await safePath(this.root, join(base, name));
            const owner = await json(join(base, name, "owner.json"), {});
            if (owner.owner !== "PersonalRaycast")
              throw new Error("Fremmed mappe ryddes ikke: " + name);
          }
        const dates = await Promise.all(
          files.map(async (name) => ({
            name,
            mtime: (await stat(await safePath(this.root, join(base, name))))
              .mtimeMs,
          })),
        );
        dates.sort((a, b) => b.mtime - a.mtime);
        const reportIds = dates
          .filter((x) => x.name.endsWith(".json"))
          .slice(0, 10)
          .map((x) => x.name.slice(0, -5));
        for (const [index, item] of dates.entries())
          if (
            dir === "releases"
              ? !keep.has(item.name)
              : !reportIds.some((id) => item.name.startsWith(id)) ||
                Date.now() - item.mtime > 14 * 86400000
          ) {
            const file = await safePath(this.root, join(base, item.name));
            deleted.push(file);
            if (!dryRun) await remove(this.root, file);
          }
      }
      return { dryRun, deleted };
    });
  }
}
