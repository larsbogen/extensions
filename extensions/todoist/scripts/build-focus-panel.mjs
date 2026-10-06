import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("The floating focus panel is macOS-only; skipping its build.");
  process.exit(0);
}

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(project, "native", "focus-panel");
const work = join(project, "work", "focus-panel-build");
const assets = join(project, "assets", "focus-panel", "FocusPanel.app", "Contents");
mkdirSync(work, { recursive: true });
mkdirSync(join(assets, "MacOS"), { recursive: true });
const common = ["-module-cache-path", join(work, "module-cache"), "-swift-version", "5"];
const run = (args) => execFileSync("/usr/bin/xcrun", ["swiftc", ...common, ...args], { stdio: "inherit" });

if (process.argv.includes("--test")) {
  const test = join(work, "session-tests");
  run([join(source, "FocusSession.swift"), join(source, "SessionTests.swift"), "-o", test]);
  execFileSync(test, [], { stdio: "inherit" });
} else {
  const binary = join(work, "FocusPanel");
  run([join(source, "FocusSession.swift"), join(source, "FocusPanel.swift"), "-O", "-o", binary]);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binary], { stdio: "inherit" });
  // Replace only after compilation succeeds, so the local watcher never sees a partial binary.
  renameSync(binary, join(assets, "MacOS", "FocusPanel"));
  writeFileSync(
    join(assets, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>FocusPanel</string>
<key>CFBundleIdentifier</key><string>local.todoist.focus-panel</string>
<key>CFBundleName</key><string>Todoist Fokus</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`,
  );
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", dirname(assets)], { stdio: "inherit" });
  console.log("Built the floating focus panel.");
}
