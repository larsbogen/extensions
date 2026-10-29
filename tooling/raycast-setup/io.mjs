import {
  mkdir,
  writeFile,
  rename,
  readFile,
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, resolve, sep, relative, join } from "node:path";
export async function json(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export async function save(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export async function safePath(root, file) {
  const base = await realpath(root),
    lexical = resolve(root),
    requested = resolve(file);
  const target = requested.startsWith(lexical + sep)
    ? join(base, relative(lexical, requested))
    : requested;
  if (!target.startsWith(base + sep))
    throw new Error("Stien er utenfor eget område.");
  let part = target;
  while (part !== base) {
    try {
      if ((await lstat(part)).isSymbolicLink())
        throw new Error("Symbolske lenker ryddes ikke.");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    part = dirname(part);
  }
  return join(await realpath(base), relative(base, target));
}
export async function remove(root, file) {
  await rm(await safePath(root, file), { recursive: true, force: true });
}
