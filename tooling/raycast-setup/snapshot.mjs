import {
  readdir,
  lstat,
  readFile,
  mkdir,
  copyFile,
  chmod,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
const ignored = new Set([
  "node_modules",
  "work",
  "dist",
  ".git",
  ".codex",
  ".agents",
]);
export async function inventory(root, prefix = "") {
  const files = {};
  for (const entry of (
    await readdir(join(root, prefix), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      ignored.has(entry.name) ||
      (prefix === "assets" && entry.name === "focus-panel") ||
      entry.name.startsWith(".env") ||
      entry.name.endsWith(".rayconfig") ||
      [".DS_Store", "raycast-env.d.ts"].includes(entry.name)
    )
      continue;
    const relative = join(prefix, entry.name),
      file = join(root, relative),
      stat = await lstat(file);
    if (stat.isSymbolicLink())
      throw new Error(`Symbolsk lenke i kildekoden: ${relative}`);
    if (stat.isDirectory())
      Object.assign(files, await inventory(root, relative));
    else if (stat.isFile())
      files[relative] = {
        hash: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
        mode: stat.mode & 0o777,
      };
  }
  return files;
}
export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function snapshot(root, destination, entries) {
  const before = {};
  for (const entry of entries)
    before[entry] = await inventory(join(root, entry));
  for (const [entry, files] of Object.entries(before))
    for (const [file, meta] of Object.entries(files)) {
      const target = join(destination, entry, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, entry, file), target);
      await chmod(target, meta.mode);
    }
  for (const entry of entries) {
    if (
      digest(before[entry]) !== digest(await inventory(join(root, entry))) ||
      digest(before[entry]) !==
        digest(await inventory(join(destination, entry)))
    )
      throw new Error("Kildekode endret under kopiering. Prøv igjen.");
  }
  return Object.fromEntries(
    Object.entries(before).map(([key, value]) => [key, digest(value)]),
  );
}
