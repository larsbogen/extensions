import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const actions = {
  install: "setup",
  status: "status",
  restart: "update",
  start: "update",
  uninstall: "status",
  stop: "status",
};
const action = process.argv[2];
if (!actions[action]) throw new Error("Bruk den felles kommandoen bin/raycast-setup.");
console.log("Lokalt oppsett bruker nå kontrollerte oppdateringer. npm run dev er fortsatt tilgjengelig for utvikling.");
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("../../../tooling/raycast-setup/cli.mjs", import.meta.url)), actions[action]],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
