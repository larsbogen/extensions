import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run directly with Node: this installer has no npm dependencies of its own.
const label = "local.raycast.todoist.dev";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const logs = join(homedir(), "Library", "Logs", label);
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const action = process.argv[2];

function launchctl(...args) {
  return execFileSync("/bin/launchctl", args, { encoding: "utf8" });
}

function loaded() {
  return spawnSync("/bin/launchctl", ["print", service], { stdio: "ignore" }).status === 0;
}

function stop() {
  if (!loaded()) return;
  launchctl("bootout", service);
  // bootout may return while the old process is still shutting down.
  const deadline = Date.now() + 15000;
  while (loaded()) {
    if (Date.now() > deadline) throw new Error("The old LaunchAgent is still stopping. Try again shortly.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function start() {
  if (!existsSync(plist)) throw new Error("Run npm run local:install first.");
  launchctl("enable", service);
  if (!loaded()) launchctl("bootstrap", domain, plist);
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function install() {
  const cli = join(project, "node_modules", "@raycast", "api", "bin", "run.js");
  if (!existsSync(cli)) throw new Error("Dependencies are missing. Run npm ci first.");
  // Prefer Homebrew's stable symlink over a versioned Cellar path.
  const node =
    ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find(
      (candidate) => existsSync(candidate) && realpathSync(candidate) === realpathSync(process.execPath),
    ) ?? process.execPath;
  const path = [
    ...new Set([dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
  ].join(delimiter);
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string>
    <string>${xml(cli)}</string>
    <string>develop</string>
    <string>--non-interactive</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(project)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>NO_COLOR</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(logs, "output.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "error.log"))}</string>
</dict></plist>
`;
  // Validate before replacing an existing installation.
  execFileSync("/usr/bin/plutil", ["-lint", "-"], { input: contents });
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  stop();
  writeFileSync(plist, contents, { mode: 0o600 });
  start();
  console.log(`Installed and started ${label}\nProject: ${project}\nLaunchAgent: ${plist}\nLogs: ${logs}`);
}

try {
  if (process.platform !== "darwin") throw new Error("This LaunchAgent requires macOS.");
  switch (action) {
    case "install":
      install();
      break;
    case "status":
      if (loaded()) console.log(launchctl("print", service));
      else console.log(existsSync(plist) ? "Installed, but stopped." : "Not installed.");
      break;
    case "start":
      start();
      console.log("Started.");
      break;
    case "stop":
      stop();
      console.log("Stopped until you start it again or next log in.");
      break;
    case "restart":
      start();
      launchctl("kickstart", "-k", service);
      console.log("Restarted.");
      break;
    case "uninstall":
      stop();
      if (existsSync(plist)) unlinkSync(plist);
      console.log(`LaunchAgent removed. Extension and logs retained.\nLogs: ${logs}`);
      break;
    default:
      throw new Error("Usage: node scripts/local-agent.mjs install|status|start|stop|restart|uninstall");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
