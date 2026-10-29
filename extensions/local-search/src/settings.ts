import { homedir } from "node:os";
import { join, resolve } from "node:path";
export type Settings = {
  libraryPath?: string;
  atlasPath?: string;
  pythonPath?: string;
  nodePath?: string;
};
export function configuration(settings: Settings, kind: "library" | "atlas") {
  const library = kind === "library";
  return {
    root: resolve(
      library
        ? settings.libraryPath || join(homedir(), "Masteroppgaver/bibliotek")
        : settings.atlasPath || join(homedir(), "Strava"),
    ),
    binary: library
      ? settings.pythonPath || "/usr/bin/python3"
      : settings.nodePath || "/opt/homebrew/bin/node",
    args: library
      ? ["control.py"]
      : ["--import", "tsx", "scripts/atlas-control.ts"],
    script: library ? "control.py" : "scripts/atlas-control.ts",
  };
}
