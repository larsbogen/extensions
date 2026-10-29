import { execFile } from "node:child_process";
import { join } from "node:path";
import { configuration, type Settings } from "./settings";
export type { Settings } from "./settings";
import { readFile } from "node:fs/promises";
export type Topic = { id: string; label: string };
export type File = { path: string; pages: number };
export type Entry = {
  id: string;
  title: string;
  authors: string[];
  year: number;
  supervisors: string[];
  keywords: string[];
  abstract: string;
  tags: string[];
  files: File[];
};
export type Fulltext = {
  status: string;
  matches: Record<
    string,
    {
      terms: string[];
      snippets: { path: string; page: number; text: string }[];
    }
  >;
};
export type Catalog = { entries: Entry[]; topics: Topic[] };
export type Tour = {
  id: string;
  title: string;
  kind: string;
  day: string | null;
  distance: number | null;
  duration: number | null;
  routeStatus: string;
  mediaCount: number;
  snippet?: string;
};
export type Tours = {
  version: number;
  items: Tour[];
  total: number;
  kinds: string[];
};
type Connection = { baseUrl: string; token?: string; serverId?: string };
export function localUrl(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("Ugyldig lokal serveradresse.");
  return u.origin;
}
export function run(
  file: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((yes, no) => {
    const child = execFile(
      file,
      args,
      { cwd, timeout: 65000, maxBuffer: 1024 * 1024 },
      (e, out) =>
        e
          ? no(
              new Error(
                "Kunne ikke starte tjenesten. Kontroller prosjektmappe, kjøretid og oppsett.",
              ),
            )
          : yes(out.trim()),
    );
    child.stdin?.end();
  });
}
export async function getJson(
  url: string,
  signal?: AbortSignal,
  token?: string,
): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(10000),
    ]),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: "error",
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        response.status === 401
          ? "Lesetilgangen er utløpt."
          : "Kunne ikke hente lokale data.",
      ),
      { status: response.status },
    );
  return response.json();
}
export function catalog(value: unknown): Catalog {
  const c = value as Catalog;
  if (
    !c ||
    !Array.isArray(c.entries) ||
    !Array.isArray(c.topics) ||
    !c.topics.every(
      (t) => typeof t.id === "string" && typeof t.label === "string",
    ) ||
    !c.entries.every(
      (e) =>
        typeof e.id === "string" &&
        typeof e.title === "string" &&
        Number.isInteger(e.year) &&
        typeof e.abstract === "string" &&
        [e.authors, e.supervisors, e.keywords, e.tags].every(
          (a) => Array.isArray(a) && a.every((s) => typeof s === "string"),
        ) &&
        Array.isArray(e.files) &&
        e.files.every(
          (f) =>
            typeof f.path === "string" &&
            Number.isInteger(f.pages) &&
            f.pages > 0,
        ),
    )
  )
    throw new Error("Biblioteket returnerte ugyldige katalogdata.");
  return c;
}
export function fulltext(value: unknown): Fulltext {
  const f = value as Fulltext;
  if (
    !f ||
    !["ready", "missing", "unavailable"].includes(f.status) ||
    !f.matches ||
    typeof f.matches !== "object" ||
    !Object.values(f.matches).every(
      (m) =>
        Array.isArray(m.terms) &&
        m.terms.every((t) => typeof t === "string") &&
        Array.isArray(m.snippets) &&
        m.snippets.every(
          (s) =>
            typeof s.path === "string" &&
            Number.isInteger(s.page) &&
            typeof s.text === "string",
        ),
    )
  )
    throw new Error("Ugyldig fulltekstsvar.");
  return f;
}
export function tours(value: unknown): Tours {
  const t = value as Tours;
  if (
    !t ||
    t.version !== 1 ||
    !Number.isInteger(t.total) ||
    t.total < 0 ||
    !Array.isArray(t.kinds) ||
    !t.kinds.every((k) => typeof k === "string") ||
    !Array.isArray(t.items) ||
    t.items.length > 100 ||
    !t.items.every(
      (a) =>
        typeof a.id === "string" &&
        typeof a.title === "string" &&
        typeof a.kind === "string" &&
        (a.day === null || /^\d{4}-\d{2}-\d{2}$/.test(a.day)) &&
        [a.distance, a.duration].every(
          (n) =>
            n === null ||
            (typeof n === "number" && Number.isFinite(n) && n >= 0),
        ) &&
        typeof a.routeStatus === "string" &&
        Number.isInteger(a.mediaCount) &&
        a.mediaCount >= 0 &&
        (a.snippet === undefined || typeof a.snippet === "string"),
    )
  )
    throw new Error("Turatlas mangler et kompatibelt søkegrensesnitt.");
  return t;
}
export function pdfUrl(
  base: string,
  entry: Entry,
  file: File,
  page?: number,
): string {
  if (
    !entry.files.some((f) => f.path === file.path) ||
    !/^pdf\/.+\.pdf$/i.test(file.path) ||
    file.path.split("/").some((s) => s === ".." || s === "." || !s) ||
    [...file.path].some((c) => c.charCodeAt(0) < 32 || c === "\\")
  )
    throw new Error("Ugyldig PDF-sti.");
  if (
    page !== undefined &&
    (!Number.isInteger(page) || page < 1 || page > file.pages)
  )
    throw new Error("Ugyldig PDF-side.");
  return `${localUrl(base)}/${file.path.split("/").map(encodeURIComponent).join("/")}${page ? `#page=${page}` : ""}`;
}
export class Services {
  private connections = new Map<string, Promise<Connection>>();
  constructor(private settings: Settings) {}
  connect(kind: "library" | "atlas", fresh = false): Promise<Connection> {
    if (fresh) this.connections.delete(kind);
    const previous = this.connections.get(kind);
    if (previous) return previous;
    const pending = this.start(kind).catch((e) => {
      this.connections.delete(kind);
      throw e;
    });
    this.connections.set(kind, pending);
    return pending;
  }
  private async start(kind: "library" | "atlas"): Promise<Connection> {
    if (kind === "library") {
      const { root, binary } = configuration(this.settings, "library");
      const baseUrl = localUrl(
        await run(binary, ["control.py", "start", "--no-open"], root),
      );
      const state = JSON.parse(
        await readFile(join(root, "state/server.json"), "utf8"),
      );
      const health = (await getJson(`${baseUrl}/health`)) as {
        service: string;
        root: string;
        instance: string;
      };
      if (
        health.service !== "uia-thesis-library" ||
        health.root !== root ||
        health.instance !== state.instance ||
        localUrl(state.url) !== baseUrl
      )
        throw new Error("Bibliotekets serveridentitet kunne ikke bekreftes.");
      return { baseUrl };
    }
    const { root, binary } = configuration(this.settings, "atlas");
    const info = JSON.parse(
      await run(
        binary,
        [
          "--import",
          "tsx",
          "scripts/atlas-control.ts",
          "raycast-info",
          "--json",
        ],
        root,
      ),
    );
    if (
      info.version !== 1 ||
      typeof info.serverId !== "string" ||
      !/^[a-f0-9]{64}$/.test(info.token)
    )
      throw new Error("Turatlas må oppdateres med støtte for lokalt søk.");
    return {
      baseUrl: localUrl(info.baseUrl),
      token: info.token,
      serverId: info.serverId,
    };
  }
  async searchAtlas(
    params: URLSearchParams,
    signal?: AbortSignal,
    retry = true,
  ): Promise<{ data: Tours; baseUrl: string }> {
    const c = await this.connect("atlas");
    try {
      return {
        data: tours(
          await getJson(
            `${c.baseUrl}/api/v1/raycast/activities?${params}`,
            signal,
            c.token,
          ),
        ),
        baseUrl: c.baseUrl,
      };
    } catch (e) {
      if (retry && (e as { status?: number }).status === 401) {
        await this.connect("atlas", true);
        return this.searchAtlas(params, signal, false);
      }
      throw e;
    }
  }
}
export const markdown = (s: string) =>
  s.replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&");
