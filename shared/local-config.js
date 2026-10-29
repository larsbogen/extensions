const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const keys = [
  "repositoryPath",
  "libraryPath",
  "atlasPath",
  "nodePath",
  "pythonPath",
  "rm2Path",
  "pdfinfoPath",
  "pdftoppmPath",
  "focusStatePath",
];
function configPath(home = os.homedir()) {
  return path.join(
    home,
    "Library/Application Support/PersonalRaycast/config.json",
  );
}
function readLocalConfig(home = os.homedir()) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(configPath(home), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Kan ikke lese PersonalRaycast-konfigurasjonen.");
  }
  return validateConfig(value);
}
function validateConfig(value) {
  if (
    !value ||
    value.version !== 1 ||
    Object.keys(value).some(
      (k) => ![...keys, "version", "components", "raycastTarget"].includes(k),
    ) ||
    !Array.isArray(value.components) ||
    value.components.some(
      (x) =>
        ![
          "todoist",
          "parallels-virtual-machines",
          "local-search",
          "scripts",
        ].includes(x),
    ) ||
    !["release", "x"].includes(value.raycastTarget)
  )
    throw new Error("Ugyldig PersonalRaycast-konfigurasjon.");
  for (const key of keys)
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || !path.isAbsolute(value[key]))
    )
      throw new Error(`Ugyldig absolutt sti: ${key}`);
  return value;
}
function recordOverrides(component, preferences, common) {
  if (!common.version || process.env.VITEST) return;
  const overrides = Object.fromEntries(
    keys
      .filter((key) => preferences[key] && preferences[key] !== common[key])
      .map((key) => [key, preferences[key]]),
  );
  try {
    const directory = path.join(path.dirname(configPath()), "overrides");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, component + ".json"),
      temporary = file + "." + process.pid;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ updatedAt: new Date().toISOString(), overrides }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } catch {
    /* Diagnostics must not stop task operations. */
  }
}
module.exports = {
  configPath,
  readLocalConfig,
  validateConfig,
  recordOverrides,
};
