#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import local from "../../shared/local-config.js";
import { save } from "./io.mjs";
import { Manager, components } from "./manager.mjs";
import { Host } from "./host.mjs";
const home = homedir(),
  root = dirname(local.configPath(home));
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Node 24 eller nyere kreves.");
  const action = process.argv[2] || "status";
  let config = local.readLocalConfig();
  if (action === "setup") {
    const changes = {};
    for (let i = 3; i < process.argv.length; i += 2) {
      const key = process.argv[i].replace(/^--/, "");
      if (
        ![
          "repositoryPath",
          "atlasPath",
          "libraryPath",
          "nodePath",
          "pythonPath",
          "focusStatePath",
          "raycastTarget",
        ].includes(key) ||
        !process.argv[i + 1]
      )
        throw new Error(
          "Ugyldig oppsettsargument. Bruk --repositoryPath /sti osv.",
        );
      changes[key] =
        key === "raycastTarget"
          ? process.argv[i + 1]
          : resolve(process.argv[i + 1]);
    }
    config = {
      version: 1,
      repositoryPath: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      atlasPath: join(home, "Strava"),
      libraryPath: join(home, "Masteroppgaver/bibliotek"),
      nodePath: process.execPath,
      pythonPath: "/usr/bin/python3",
      components,
      raycastTarget: "release",
      ...config,
      ...changes,
    };
    local.validateConfig(config);
    await save(local.configPath(), config);
    local.readLocalConfig();
  }
  if (!config.version && action === "launch")
    config = {
      version: 1,
      repositoryPath: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      atlasPath: join(home, "Strava"),
      libraryPath: join(home, "Masteroppgaver/bibliotek"),
      nodePath: process.execPath,
      pythonPath: "/usr/bin/python3",
      raycastTarget: "release",
      components,
    };
  if (!config.version) throw new Error("Kjør ./bin/raycast-setup setup først.");
  const manager = new Manager(config, root, new Host(config, root, home));
  if (action === "launch") {
    const kind = process.argv[3];
    if (!["atlas", "library"].includes(kind))
      throw new Error("Ukjent tjeneste.");
    const { spawn } = await import("node:child_process");
    const child = spawn(
      kind === "atlas" ? config.nodePath : config.pythonPath,
      kind === "atlas"
        ? [
            "--import",
            "tsx",
            "scripts/atlas-control.ts",
            "start",
            ...process.argv.slice(4),
          ]
        : ["control.py", "start", ...process.argv.slice(4)],
      {
        cwd: kind === "atlas" ? config.atlasPath : config.libraryPath,
        stdio: "inherit",
      },
    );
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("exit", (code) => (process.exitCode = code ?? 1));
    return;
  }
  let result;
  if (action === "setup" || action === "update")
    result = await manager.update();
  else if (action === "check") result = await manager.check();
  else if (action === "rollback") result = await manager.rollback();
  else if (action === "status") result = await manager.status();
  else if (action === "clean")
    result = await manager.clean(process.argv.includes("--dry-run"));
  else
    throw new Error(
      "Bruk setup, check, update, rollback, status eller clean [--dry-run].",
    );
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
