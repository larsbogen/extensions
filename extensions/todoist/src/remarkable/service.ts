import { readLocalConfig, recordOverrides } from "../../../../shared/local-config";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { osloDay, type PlanSnapshot } from "./plan";
import { PAGE_SIZE, type PdfRenderer } from "./pdf";
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
// Restore only today's unsent snapshot; never retry a sent or ambiguous upload.
export function shouldResumePreview(job: ExportJob | undefined, now = new Date()): job is ExportJob {
  return !!job && job.state === "ready" && job.pages > 0 && job.snapshot.day === osloDay(now);
}

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
  const common = readLocalConfig();
  recordOverrides("todoist", prefs, common);
  prefs = {
    rm2Path: prefs.rm2Path || common.rm2Path,
    pdfinfoPath: prefs.pdfinfoPath || common.pdfinfoPath,
    pdftoppmPath: prefs.pdftoppmPath || common.pdftoppmPath,
  };
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
      sizes.some((m) => Math.abs(Number(m[2]) - PAGE_SIZE[0]) > 2 || Math.abs(Number(m[3]) - PAGE_SIZE[1]) > 2)
    ) {
      throw new Error("Alle PDF-sider må ha reMarkable-format (3:4, stående).");
    }
  }
  return pages;
}

function validatePng(bytes: Buffer): void {
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

export class DailyPlanService {
  private latestReads = new Map<string, Promise<ExportJob | undefined>>();
  private previewReads = new Map<string, Promise<string[]>>();
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
    if (
      job.version !== 1 ||
      job.id !== id ||
      !UUID.test(job.folder.id) ||
      ![1, 2].includes(job.snapshot?.version) ||
      !Array.isArray(job.snapshot?.tasks)
    )
      throw new Error("Ugyldig lagret eksportjobb.");
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
        job.pdfHash = createHash("sha256")
          .update(await readFile(pdf))
          .digest("hex");
        job.pages = pages;
        await this.renderImages(job, tools);
        job.state = "ready";
        await this.save(job);
        onState("ready");
        return job;
      } catch (error) {
        await rm(path.join(directory, "preview"), { recursive: true, force: true });
        job.state = "error";
        job.error = error instanceof Error ? error.message : "Eksporten mislyktes.";
        await this.save(job);
        onState("error");
        throw new Error(job.error);
      }
    });
  }
  private async renderImages(job: ExportJob, tools: Tools): Promise<string[]> {
    const directory = this.directory(job.id);
    const temporary = path.join(directory, "rendered");
    const preview = path.join(directory, "preview");
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      const result = await this.run(
        tools.pdftoppm,
        ["-png", "-r", "130", this.pdfPath(job), path.join(temporary, "page")],
        { env: this.environment(), timeoutMs: 180_000 },
      );
      if (result.code !== 0) throw new Error("Ikke alle PDF-sidene kunne rendres.");
      const files = await this.imageFiles(temporary, job.pages);
      const hashes = await Promise.all(
        files.map(async (name) => {
          const bytes = await readFile(path.join(temporary, name));
          validatePng(bytes);
          return { name, hash: createHash("sha256").update(bytes).digest("hex") };
        }),
      );
      await writeFile(path.join(temporary, "manifest.json"), JSON.stringify({ pdfHash: job.pdfHash, pages: hashes }), {
        mode: 0o600,
      });
      await rm(preview, { recursive: true, force: true });
      await rename(temporary, preview);
      return files.map((file) => path.join(preview, file));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  private async imageFiles(directory: string, pages: number): Promise<string[]> {
    const files = (await readdir(directory)).filter((name) => /^page-\d+\.png$/.test(name));
    files.sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    if (files.length !== pages || files.some((name, index) => Number(name.match(/\d+/)?.[0]) !== index + 1))
      throw new Error("Det mangler renderte PDF-sider.");
    return files;
  }
  /** Read or restore a local image cache; never changes the PDF, upload state or snapshot. */
  previewPages(id: string): Promise<string[]> {
    const pending = this.previewReads.get(id);
    if (pending) return pending;
    const operation = this.locked(async () => {
      const job = await this.load(id);
      if (!job.pages || !job.pdfHash) throw new Error("Eksporten har ingen validert PDF-forhåndsvisning.");
      const hash = createHash("sha256")
        .update(await readFile(this.pdfPath(job)))
        .digest("hex");
      if (hash !== job.pdfHash) throw new Error("PDF-en er endret etter forhåndsvisningen. Lag en ny forhåndsvisning.");
      const preview = path.join(this.directory(id), "preview");
      try {
        const manifest = JSON.parse(await readFile(path.join(preview, "manifest.json"), "utf8"));
        if (manifest.pdfHash !== hash || !Array.isArray(manifest.pages)) throw new Error("Utdatert bildecache.");
        const files = await this.imageFiles(preview, job.pages);
        if (manifest.pages.length !== files.length) throw new Error("Ufullstendig bildecache.");
        await Promise.all(
          files.map(async (name, index) => {
            const bytes = await readFile(path.join(preview, name));
            validatePng(bytes);
            const expected = manifest.pages[index];
            if (expected?.name !== name || expected.hash !== createHash("sha256").update(bytes).digest("hex"))
              throw new Error("Ugyldig bildecache.");
          }),
        );
        return files.map((file) => path.join(preview, file));
      } catch {
        const tools = await resolveTools(this.prefs);
        const info = await this.run(tools.pdfinfo, ["-f", "1", "-l", String(job.pages), this.pdfPath(job)], {
          env: this.environment(),
        });
        if (info.code !== 0) throw new Error("PDF-sidene kunne ikke valideres.");
        validatePdfInfo(info.stdout, job.pages);
        return await this.renderImages(job, tools);
      }
    }).finally(() => this.previewReads.delete(id));
    this.previewReads.set(id, operation);
    return operation;
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
  latest(accountId?: string): Promise<ExportJob | undefined> {
    // React can run initialization twice. Share that read instead of treating
    // the second initialization as a competing export job.
    const key = accountId ?? "";
    const pending = this.latestReads.get(key);
    if (pending) return pending;
    const operation = this.locked(async () => {
      const jobs: ExportJob[] = [];
      for (const entry of await readdir(this.root)) {
        if (!UUID.test(entry)) continue;
        try {
          const job = await this.load(entry);
          if (accountId && job.snapshot.version === 2 && job.snapshot.workday.accountId !== accountId) continue;
          if (Date.now() - Date.parse(job.createdAt) < SEVEN_DAYS && job.pages) jobs.push(job);
        } catch {
          /* ignore incomplete jobs */
        }
      }
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    }).finally(() => {
      this.latestReads.delete(key);
    });
    this.latestReads.set(key, operation);
    return operation;
  }
}
