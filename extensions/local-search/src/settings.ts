import { readLocalConfig, recordOverrides } from "../../../shared/local-config";
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
  const common = readLocalConfig();
  recordOverrides("local-search", settings, common);
  return {
    root: resolve(
      library
        ? settings.libraryPath ||
            common.libraryPath ||
            join(homedir(), "Masteroppgaver/bibliotek")
        : settings.atlasPath || common.atlasPath || join(homedir(), "Strava"),
    ),
    binary: library
      ? settings.pythonPath || common.pythonPath || "/usr/bin/python3"
      : settings.nodePath || common.nodePath || "/opt/homebrew/bin/node",
    args: library
      ? ["control.py"]
      : ["--import", "tsx", "scripts/atlas-control.ts"],
    script: library ? "control.py" : "scripts/atlas-control.ts",
  };
}
