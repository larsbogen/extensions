import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { PlanSnapshot } from "./plan";
import type { PdfRenderer } from "./pdf";
import { planMarkdown } from "./markdown";
import { runProcess, type Runner } from "./process";

export type ToolPreferences = {
  rm2Path?: string;
  pdfinfoPath?: string;
  pdftoppmPath?: string;
};
export type Folder = { id: string; name: string; parent?: string };
export type JobState = "exporting" | "validating" | "ready" | "sending" | "sent" | "uncertain" | "error";
export type ExportJob = {
  version: 1;
  id: string;
  createdAt: string;
  snapshot: PlanSnapshot;
  folder: Folder;
  state: JobState;
  pages: number;
  pdfHash?: string;
  documentId?: string;
  error?: string;
};
type Tools = { rm2: string; pdfinfo: string; pdftoppm: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
export const FOLDER_LOGIN = "Mappetilgang mangler. Kjør rm2 cloud web-login i Terminal, og hent mappene på nytt.";
export const UPLOAD_LOGIN = "Innlogging for opplasting mangler. Kjør rm2 cloud login i Terminal, og prøv igjen.";

function expand(value: string) {
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}
async function executable(label: string, override: string | undefined, defaults: string[]) {
  const candidates = override?.trim() ? [expand(override.trim())] : defaults;
  for (const candidate of candidates) {
    try {
      if (path.isAbsolute(candidate)) {
        await access(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      /* try next path */
    }
  }
  throw new Error(`${label} ble ikke funnet. Angi en absolutt verktøysti i kommandoens innstillinger.`);
}
export async function resolveTools(prefs: ToolPreferences): Promise<Tools> {
  const search = (name: string) =>
    [...new Set(["/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "").split(path.delimiter), "/usr/bin"])]
      .filter(Boolean)
      .map((dir) => path.join(dir, name));
  const poppler = (name: string) => [
    ...search(name),
    path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override", name),
  ];
  return {
    rm2: await executable("rm2", prefs.rm2Path, [path.join(homedir(), "Library/Python/3.9/bin/rm2"), ...search("rm2")]),
    pdfinfo: await executable("pdfinfo (Poppler)", prefs.pdfinfoPath, poppler("pdfinfo")),
    pdftoppm: await executable("pdftoppm (Poppler)", prefs.pdftoppmPath, poppler("pdftoppm")),
  };
}

export function parseFolders(stdout: string): Folder[] {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("rm2 returnerte et ugyldig mappesvar. Oppdater rm2 og prøv igjen.");
  }
  if (!payload || payload.protocol_version !== 1) throw new Error("Oppdater rm2; mappesvaret har et ukjent format.");
  if (!payload.ok) {
    if (payload.error?.code === "read_auth") throw new Error(FOLDER_LOGIN);
    if (payload.error?.code === "upload_auth") throw new Error(UPLOAD_LOGIN);
    if (payload.error?.code === "account_mismatch")
      throw new Error("Mappe- og opplastingsinnloggingen må tilhøre samme reMarkable-konto.");
    if (payload.error?.code === "keychain")
      throw new Error("rm2 fikk ikke tilgang til macOS Nøkkelring. Kontroller tilgangen og prøv igjen.");
    throw new Error("Kunne ikke hente Cloud-mapper. Kontroller nettverket og rm2-installasjonen, og prøv igjen.");
  }
  if (!Array.isArray(payload.data)) throw new Error("rm2 returnerte et ugyldig mappesvar.");
  return payload.data
    .filter(
      (item: { kind?: string; upload_parent_id?: string; name?: string }) =>
        item &&
        item.kind === "folder" &&
        typeof item.upload_parent_id === "string" &&
        UUID.test(item.upload_parent_id) &&
        typeof item.name === "string",
    )
    .map((item: { upload_parent_id: string; name: string; parent?: string }) => ({
      id: item.upload_parent_id,
      name: item.name,
      ...(typeof item.parent === "string" ? { parent: item.parent } : {}),
    }));
}

export function validatePdfInfo(output: string, expectedPages?: number): number {
  const pages = Number(output.match(/^Pages:\s+(\d+)\s*$/m)?.[1]);
  if (!Number.isInteger(pages) || pages < 1 || (expectedPages !== undefined && pages !== expectedPages))
    throw new Error("PDF-en har ugyldig sideantall.");
  if (expectedPages !== undefined) {
    const sizes = [...output.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)];
    if (
      sizes.length !== pages ||
      new Set(sizes.map((m) => m[1])).size !== pages ||
      sizes.some((m) => Math.abs(Number(m[2]) - 595.28) > 2 || Math.abs(Number(m[3]) - 841.89) > 2)
    ) {
      throw new Error("Alle PDF-sider må være A4 stående.");
    }
  }
  return pages;
}

export class DailyPlanService {
  constructor(
    readonly root: string,
    readonly prefs: ToolPreferences,
    private renderPdf: PdfRenderer,
    private run: Runner = runProcess,
  ) {}
  directory(id: string) {
    if (!UUID.test(id)) throw new Error("Ugyldig eksport-ID.");
    return path.join(this.root, id);
  }
  pdfPath(job: ExportJob) {
    return path.join(this.directory(job.id), "plan.pdf");
  }
  private async save(job: ExportJob) {
    const directory = this.directory(job.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, "job.json.tmp"), JSON.stringify(job), { mode: 0o600 });
    await rename(path.join(directory, "job.json.tmp"), path.join(directory, "job.json"));
  }
  async load(id: string): Promise<ExportJob> {
    const job = JSON.parse(await readFile(path.join(this.directory(id), "job.json"), "utf8")) as ExportJob;
    if (job.version !== 1 || job.id !== id || !UUID.test(job.folder.id)) throw new Error("Ugyldig lagret eksportjobb.");
    return job;
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.root, ".lock");
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let alive = true;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
          }
        }
      } catch {
        /* a live process may still be writing the lock */
      }
      if (alive) throw new Error("En eksport, sending eller mappeopprettelse pågår allerede. Vent til den er ferdig.");
      await rm(lockPath);
      handle = await open(lockPath, "wx", 0o600);
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await this.cleanup();
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
  private async cleanup() {
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const directory = this.directory(entry.name);
      let created = (await stat(directory)).mtimeMs;
      try {
        created = Date.parse((await this.load(entry.name)).createdAt);
      } catch {
        /* incomplete job */
      }
      if (Number.isFinite(created) && Date.now() - created > SEVEN_DAYS)
        await rm(directory, { recursive: true, force: true });
    }
  }
  private environment() {
    return {
      ...process.env,
      LC_ALL: "C",
      PYTHONUTF8: "1",
      PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "", "/usr/bin", "/bin"].join(path.delimiter),
    };
  }
  private rm2() {
    return executable("rm2", this.prefs.rm2Path, [
      path.join(homedir(), "Library/Python/3.9/bin/rm2"),
      "/opt/homebrew/bin/rm2",
      "/usr/local/bin/rm2",
    ]);
  }
  async folders(): Promise<Folder[]> {
    const rm2 = await this.rm2();
    const result = await this.run(rm2, ["cloud", "list", "--kind", "folder", "--fresh", "--app-json"], {
      env: this.environment(),
    });
    if (result.code !== 0 && !result.stdout.trim())
      throw new Error("rm2 kunne ikke hente mapper. Kontroller installasjon og nettverk.");
    return parseFolders(result.stdout).sort(
      (a, b) => Number(b.name === "Dagsplaner") - Number(a.name === "Dagsplaner") || a.name.localeCompare(b.name, "nb"),
    );
  }
  async createFolder(rawName: string): Promise<Folder> {
    const name = rawName.trim().normalize("NFC");
    if (!name || [...name].length > 255 || [...name].some((char) => char.charCodeAt(0) < 32 || "/\\".includes(char)))
      throw new Error("Bruk et mappenavn på 1–255 tegn uten skråstreker eller kontrolltegn.");
    return this.locked(async () => {
      const uncertain =
        "Mappeopprettelsen kunne ikke bekreftes. Oppdater mappelisten og kontroller reMarkable før et nytt forsøk.";
      const key = createHash("sha256").update(name.toLocaleLowerCase("nb")).digest("hex");
      const marker = path.join(this.root, `folder-create-${key}.json`);
      try {
        await access(marker);
        // An interrupted/ambiguous creation may have succeeded. Only a fresh listing can recover it.
        const matches = (await this.folders()).filter(
          (f) => f.parent === "" && f.name.toLocaleLowerCase("nb") === name.toLocaleLowerCase("nb"),
        );
        if (matches.length !== 1) throw new Error(uncertain);
        await rm(marker);
        return matches[0];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const rm2 = await this.rm2();
      const env = this.environment();
      const capabilities = await this.run(rm2, ["cloud", "capabilities", "--json"], { env });
      let supported = false;
      try {
        const result = JSON.parse(capabilities.stdout);
        supported =
          capabilities.code === 0 &&
          result.protocol_version === 1 &&
          result.ok === true &&
          Array.isArray(result.data?.features) &&
          result.data.features.includes("create_folder") &&
          result.data.features.includes("fresh_listing");
      } catch {
        /* old CLI */
      }
      if (!supported)
        throw new Error("Oppdater rm2 med støtte for ferske mapper og cloud mkdir; se utvidelsens README.");
      await writeFile(marker, JSON.stringify({ name, createdAt: new Date().toISOString() }), { mode: 0o600 });
      let result;
      try {
        result = await this.run(rm2, ["cloud", "mkdir", "--app-json", "--", name], { env });
      } catch {
        throw new Error(uncertain);
      }
      let payload;
      try {
        payload = JSON.parse(result.stdout);
      } catch {
        throw new Error(uncertain);
      }
      if (payload?.protocol_version !== 1) throw new Error(uncertain);
      if (!payload.ok) {
        const code = payload.error?.code;
        const known = [
          "read_auth",
          "upload_auth",
          "account_mismatch",
          "invalid_name",
          "invalid_parent",
          "duplicate_folder",
          "folder_rejected",
          "keychain",
          "local_file",
        ];
        if (!known.includes(code) || payload.error?.may_have_uploaded) throw new Error(uncertain);
        await rm(marker);
        if (code === "read_auth") throw new Error(FOLDER_LOGIN);
        if (code === "upload_auth") throw new Error(UPLOAD_LOGIN);
        if (code === "account_mismatch")
          throw new Error("Mappe- og opplastingsinnloggingen må tilhøre samme reMarkable-konto.");
        if (code === "duplicate_folder")
          throw new Error("Flere mapper har dette navnet. Velg en eksisterende mappe fra listen.");
        throw new Error(
          "Mappen ble ikke opprettet. Kontroller navn, innlogging og tilgang til Nøkkelring, og prøv igjen.",
        );
      }
      if (result.code !== 0) throw new Error(uncertain);
      const folders = parseFolders(JSON.stringify({ ...payload, data: [payload.data] }));
      if (folders.length !== 1) throw new Error(uncertain);
      await rm(marker);
      return folders[0];
    });
  }
  async export(
    snapshot: PlanSnapshot,
    folder: Folder,
    onState: (state: JobState) => void = () => {},
  ): Promise<ExportJob> {
    return this.locked(async () => {
      if (snapshot.tasks.length === 0 || !UUID.test(folder.id)) throw new Error("Velg oppgaver og en gyldig målmappe.");
      const job: ExportJob = {
        version: 1,
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        snapshot: JSON.parse(JSON.stringify(snapshot)),
        folder: { ...folder },
        state: "exporting",
        pages: 0,
      };
      const directory = this.directory(job.id);
      try {
        await access(directory);
        throw new Error("Denne eksporten finnes allerede. Lag en ny forhåndsvisning.");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await this.save(job);
      const rendered = path.join(directory, "rendered");
      try {
        onState("exporting");
        const tools = await resolveTools(this.prefs);
        const env = this.environment();
        const markdown = path.join(directory, `plan-${job.id}.md`);
        await writeFile(markdown, planMarkdown(job.snapshot), { mode: 0o600 });
        const pdf = this.pdfPath(job);
        await this.renderPdf(job.snapshot, pdf);
        job.state = "validating";
        await this.save(job);
        onState("validating");
        const info = await this.run(tools.pdfinfo, [pdf], { env });
        if (info.code !== 0) throw new Error("PDF-en kunne ikke leses.");
        const pages = validatePdfInfo(info.stdout);
        const allPages = await this.run(tools.pdfinfo, ["-f", "1", "-l", String(pages), pdf], { env });
        if (allPages.code !== 0) throw new Error("PDF-sidene kunne ikke valideres.");
        validatePdfInfo(allPages.stdout, pages);
        await mkdir(rendered, { recursive: true });
        const renderedResult = await this.run(tools.pdftoppm, ["-png", "-r", "130", pdf, path.join(rendered, "page")], {
          env,
          timeoutMs: 180_000,
        });
        if (renderedResult.code !== 0) throw new Error("Ikke alle PDF-sidene kunne rendres.");
        const files = (await readdir(rendered)).filter((name) => /^page-\d+\.png$/.test(name));
        const indices = files.map((name) => Number(name.match(/\d+/)?.[0])).sort((a, b) => a - b);
        if (indices.length !== pages || indices.some((n, i) => n !== i + 1))
          throw new Error("Det mangler renderte PDF-sider.");
        for (const file of files) {
          const bytes = await readFile(path.join(rendered, file));
          if (
            bytes.length < 45 ||
            !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.toString("ascii", 12, 16) !== "IHDR" ||
            bytes.readUInt32BE(16) === 0 ||
            bytes.readUInt32BE(20) === 0 ||
            bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND"
          )
            throw new Error("En PDF-side kunne ikke rendres som PNG.");
        }
        job.pdfHash = createHash("sha256")
          .update(await readFile(pdf))
          .digest("hex");
        job.pages = pages;
        job.state = "ready";
        await this.save(job);
        onState("ready");
        return job;
      } catch (error) {
        job.state = "error";
        job.error = error instanceof Error ? error.message : "Eksporten mislyktes.";
        await this.save(job);
        onState("error");
        throw new Error(job.error);
      } finally {
        await rm(rendered, { recursive: true, force: true });
      }
    });
  }
  async send(id: string): Promise<ExportJob> {
    return this.locked(async () => {
      const job = await this.load(id);
      if (job.state !== "ready" || !job.pages)
        throw new Error("Denne eksporten kan ikke sendes igjen. Kontroller reMarkable før du lager et nytt dokument.");
      const tools = await resolveTools(this.prefs);
      const env = this.environment();
      const hash = createHash("sha256")
        .update(await readFile(this.pdfPath(job)))
        .digest("hex");
      if (hash !== job.pdfHash) throw new Error("PDF-en er endret etter forhåndsvisningen. Lag en ny forhåndsvisning.");
      // Authentication is checked before entering the ambiguous upload boundary.
      const status = await this.run(tools.rm2, ["cloud", "status"], { env });
      if (status.code !== 0 || !status.stdout.includes("upload: supported")) {
        job.error = UPLOAD_LOGIN;
        await this.save(job);
        return job;
      }
      job.state = "sending";
      await this.save(job);
      try {
        const result = await this.run(
          tools.rm2,
          ["cloud", "upload", this.pdfPath(job), "--name", job.snapshot.name, "--parent", job.folder.id],
          { env, timeoutMs: 180_000 },
        );
        // Parse only rm2's positive upload confirmation, never arbitrary stderr.
        const idMatch = result.stdout.match(/^Uploaded .+ as ([0-9a-f-]{36})\s*$/im);
        if (idMatch && UUID.test(idMatch[1])) {
          job.state = "sent";
          job.documentId = idMatch[1];
          job.error = undefined;
        } else {
          job.state = "uncertain";
          job.error =
            "Sendingen kunne ikke bekreftes. Kontroller reMarkable før du eventuelt lager en ny eksport. Ikke send automatisk på nytt.";
        }
      } catch {
        job.state = "uncertain";
        job.error =
          "Forbindelsen ble brutt eller tidsavbrutt. Dokumentet kan være sendt. Kontroller reMarkable før et nytt forsøk.";
      }
      await this.save(job);
      return job;
    });
  }
  async latest(): Promise<ExportJob | undefined> {
    return this.locked(async () => {
      const jobs: ExportJob[] = [];
      for (const entry of await readdir(this.root)) {
        if (!UUID.test(entry)) continue;
        try {
          const job = await this.load(entry);
          if (Date.now() - Date.parse(job.createdAt) < SEVEN_DAYS && job.pages) jobs.push(job);
        } catch {
          /* ignore incomplete jobs */
        }
      }
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    });
  }
}
