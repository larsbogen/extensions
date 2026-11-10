import { execFile, spawn } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { NoteEntry } from "./notes-search";

const exec = promisify(execFile);
export type SkippedNote = { document: string; page?: number; reason: string };
export type NotesCatalog = {
  version: 1;
  root: string;
  entries: NoteEntry[];
  skipped: SkippedNote[];
};
export type IndexReport = {
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: SkippedNote[];
};

function safeRelative(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !isAbsolute(value) &&
    !value.includes("\0") &&
    value
      .split("/")
      .every(
        (component) => component && component !== ".." && component !== ".",
      )
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isEntry(value: unknown): value is NoteEntry {
  return (
    object(value) &&
    typeof value.id === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(value.id) &&
    safeRelative(value.document) &&
    typeof value.page === "number" &&
    Number.isSafeInteger(value.page) &&
    value.page > 0 &&
    typeof value.ink === "string" &&
    typeof value.context === "string" &&
    typeof value.uncertain === "boolean" &&
    Array.isArray(value.alternatives) &&
    value.alternatives.every((item) => typeof item === "string") &&
    Array.isArray(value.rect) &&
    value.rect.length === 4 &&
    value.rect.every(Number.isFinite) &&
    safeRelative(value.preview) &&
    value.preview.toLowerCase().endsWith(".png")
  );
}
function skipped(value: unknown): value is SkippedNote[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        object(v) &&
        typeof v.document === "string" &&
        typeof v.reason === "string" &&
        (v.page === undefined ||
          (typeof v.page === "number" &&
            Number.isSafeInteger(v.page) &&
            v.page > 0)),
    )
  );
}

async function sourceRoot(root: string): Promise<string> {
  if (!isAbsolute(root))
    throw new Error("Velg en lokal importmappe i innstillingene.");
  const resolved = await realpath(root).catch(() => {
    throw new Error("Fant ikke importmappen. Kontroller innstillingen.");
  });
  if (!(await stat(resolved)).isDirectory())
    throw new Error("Importkilden må være en mappe.");
  return resolved;
}

async function storeFile(store: string, file: string): Promise<string> {
  if (!safeRelative(file) || !(await lstat(store)).isDirectory())
    throw new Error("Ugyldig indeksmappe.");
  const base = await realpath(store);
  const path = await realpath(join(base, file));
  const child = relative(base, path);
  if (
    !child ||
    child === ".." ||
    child.startsWith(".." + sep) ||
    isAbsolute(child) ||
    !(await stat(path)).isFile()
  ) {
    throw new Error("Ugyldig fil i notatindeksen.");
  }
  return path;
}

export async function readNotesCatalog(
  root: string,
  store: string,
): Promise<NotesCatalog | null> {
  const selected = await sourceRoot(root);
  let raw: string;
  try {
    raw = await readFile(await storeFile(store, "catalog.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    /* Gives the same action as an unsupported index structure. */
  }
  if (!object(v) || v.version !== 1 || typeof v.root !== "string") {
    throw new Error("Indeksen kan ikke leses. Oppdater indeksen.");
  }
  // Foundation and Node can spell the same macOS path with different volume aliases.
  if (
    !isAbsolute(v.root) ||
    (v.root !== selected &&
      (await realpath(v.root).catch(() => null)) !== selected)
  )
    return null;
  if (
    !Array.isArray(v.entries) ||
    !v.entries.every(isEntry) ||
    !skipped(v.skipped)
  )
    throw new Error("Ugyldig notatindeks. Oppdater indeksen.");
  return { version: 1, root: selected, entries: v.entries, skipped: v.skipped };
}

export async function previewURL(
  store: string,
  preview: string,
): Promise<string> {
  if (!preview.toLowerCase().endsWith(".png"))
    throw new Error("Ugyldig forhåndsvisning.");
  return pathToFileURL(await storeFile(store, preview)).href;
}

export async function indexNotes(
  helper: string,
  root: string,
  store: string,
): Promise<IndexReport> {
  const args = ["index", "--root", await sourceRoot(root), "--store", store];
  let output: string;
  try {
    ({ stdout: output } = await exec(helper, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(
      (error as { stderr?: string }).stderr?.trim() ||
        "Kunne ikke starte indekseringen. Kontroller installasjonen.",
    );
  }
  const v: unknown = JSON.parse(output);
  if (
    !object(v) ||
    !["indexed", "unchanged", "removed"].every(
      (key) => Number.isSafeInteger(v[key]) && Number(v[key]) >= 0,
    ) ||
    !skipped(v.skipped)
  ) {
    throw new Error("Ukjent svar fra indekseringen.");
  }
  return v as IndexReport;
}

/** The reader stays open after Raycast exits. READY is emitted only after the requested page is available. */
export async function openNote(
  helper: string,
  root: string,
  store: string,
  id: string,
): Promise<void> {
  const args = [
    "open",
    "--root",
    await sourceRoot(root),
    "--store",
    store,
    "--id",
    id,
  ];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(helper, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false,
      stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PDF-leseren svarte ikke."));
    }, 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-8192);
      if (!ready && stdout.split("\n").slice(0, -1).includes("READY")) {
        ready = true;
        clearTimeout(timer);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolve();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2048);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new Error("Kunne ikke starte PDF-leseren. Kontroller installasjonen."),
      );
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!ready)
        reject(
          new Error(
            stderr.trim() || "Kunne ikke åpne riktig side. Oppdater indeksen.",
          ),
        );
    });
  });
}
