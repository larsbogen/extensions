import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const label = "local.todoist.focus-context-menu";
const exec = promisify(execFile);
const xml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character],
  );

export function launchAgentPlist({ nodePath, servicePath, configPath }) {
  if (![nodePath, servicePath, configPath].every(isAbsolute)) throw new Error("Alle stier må være absolutte.");
  const args = [nodePath, servicePath, "--config", configPath]
    .map((value) => `<string>${xml(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

async function main() {
  const [action, flag, suppliedPath, ...extra] = process.argv.slice(2);
  if (
    !["print", "install", "uninstall"].includes(action) ||
    (extra.length && (extra.length !== 2 || extra[0] !== "--node" || !isAbsolute(extra[1]))) ||
    (action !== "uninstall" && (flag !== "--config" || !suppliedPath)) ||
    (action === "uninstall" && flag)
  ) {
    throw new Error(
      "Bruk print/install --config /absolutt/privat/config.json [--node /stabil/sti/node] eller uninstall.",
    );
  }
  const destination = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  if (action === "uninstall") {
    if (process.platform !== "darwin") throw new Error("LaunchAgent krever macOS.");
    // Only remove the exact agent this helper owns. Never reset other agents.
    let existing;
    try {
      existing = await readFile(destination, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing && !existing.includes(`<string>${label}</string>`))
      throw new Error("Ukjent LaunchAgent; lar filen stå.");
    try {
      await exec("/bin/launchctl", ["print", `${domain}/${label}`]);
    } catch {
      if (!existing) return;
    }
    // bootout may report that the known agent is already unloaded.
    try {
      await exec("/bin/launchctl", ["bootout", `${domain}/${label}`]);
    } catch (error) {
      if (!/Could not find service|No such process/i.test(error.stderr ?? "")) throw error;
    }
    await rm(destination, { force: true });
    console.log("Fokusbroens LaunchAgent er fjernet. Privat konfigurasjon og kvitteringer er beholdt.");
    return;
  }
  const configPath = await realpath(resolve(suppliedPath));
  const { readConfig } = await import("./service.mjs");
  await readConfig(configPath);
  const nodePath = extra[1] ?? process.execPath;
  await access(nodePath, constants.X_OK);
  const plist = launchAgentPlist({
    nodePath,
    servicePath: fileURLToPath(new URL("./service.mjs", import.meta.url)),
    configPath,
  });
  if (action === "print") {
    process.stdout.write(plist);
    return;
  }
  if (process.platform !== "darwin") throw new Error("LaunchAgent krever macOS.");
  await mkdir(dirname(destination), { recursive: true });
  // Refuse overwriting an installed agent; uninstall is explicit and separate.
  await writeFile(destination, plist, { mode: 0o600, flag: "wx" });
  try {
    await exec("/bin/launchctl", ["bootstrap", domain, destination]);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  console.log("Fokusbroen er installert for denne brukeren og starter ved innlogging.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      "Kunne ikke administrere fokusbroen. Kontroller kommando, privat konfigurasjon og om agenten allerede er installert.",
    );
    process.exitCode = 1;
  });
}
