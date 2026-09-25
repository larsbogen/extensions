import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSnapshot } from "../src/remarkable/plan";
import {
  DailyPlanService,
  parseFolders,
  resolveTools,
  validatePdfInfo,
  type Folder,
  type ToolPreferences,
} from "../src/remarkable/service";
import type { Runner } from "../src/remarkable/process";

const folder: Folder = { id: "11111111-1111-4111-8111-111111111111", name: "Dagsplaner" };
const documentId = "22222222-2222-4222-8222-222222222222";
let directory: string;
let prefs: ToolPreferences;
const snapshot = () =>
  createSnapshot(
    [{ id: "a", title: "Oppgave", projectId: "p", projectName: "Hjem", priority: 1, overdue: false }],
    new Set(["a"]),
  );
const info = "Pages: 2\nPage 1 size: 447 x 596 pts\nPage 2 size: 447 x 596 pts\n";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
  "base64",
);
let runner: ReturnType<typeof vi.fn<Runner>>;
let service: DailyPlanService;
let renderer: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "raycast-daily-plan-test-"));
  prefs = { rm2Path: "/usr/bin/true", pdfinfoPath: "/usr/bin/true", pdftoppmPath: "/usr/bin/true" };
  renderer = vi.fn(async (_snapshot, output: string) => {
    await writeFile(output, "%PDF-test");
  });
  runner = vi.fn<Runner>(async (_exe, args) => {
    if (args[0] === "-png") {
      const out = path.dirname(args.at(-1)!);
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "page-1.png"), png);
      await writeFile(path.join(out, "page-2.png"), png);
    }
    if (args[1] === "status") return { code: 0, stdout: "upload: supported", stderr: "" };
    if (args[1] === "upload") return { code: 0, stdout: `Uploaded 'Dagsplan' as ${documentId}\n`, stderr: "" };
    return { code: 0, stdout: info, stderr: "" };
  });
  service = new DailyPlanService(path.join(directory, "jobs"), prefs, renderer, runner);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("setup and PDF validation", () => {
  it("uses the canonical upload parent ID, not the web API row ID", () => {
    expect(
      parseFolders(
        JSON.stringify({
          protocol_version: 1,
          ok: true,
          data: [{ id: "web-id", kind: "folder", name: "Dagsplaner", upload_parent_id: folder.id }],
        }),
      ),
    ).toEqual([folder]);
  });
  it("gives login guidance without exposing raw errors or tokens", () => {
    expect(() =>
      parseFolders('{"protocol_version":1,"ok":false,"error":{"code":"read_auth","token":"secret"}}'),
    ).toThrow("rm2 cloud web-login");
  });
  it("fails on a missing binary with setup guidance", async () => {
    await expect(resolveTools({ ...prefs, pdfinfoPath: "/no/such/pdfinfo" })).rejects.toThrow(
      "pdfinfo (Poppler) ble ikke funnet",
    );
  });
  it.each([
    "Pages: 0",
    "not a PDF",
    info.replace("596", "700"),
    "Pages: 2\nPage 1 size: 595.28 x 841.89 pts (A4)\nPage 2 size: 595.28 x 841.89 pts (A4)\n",
    "Pages: 2\nPage 1 size: 447 x 596 pts\n",
  ])("rejects invalid or mixed-size PDF information", (value) => {
    expect(() => validatePdfInfo(value, 2)).toThrow();
  });
  it("accepts every reMarkable-sized page", () => {
    expect(validatePdfInfo(info, 2)).toBe(2);
  });
});

describe("preview pipeline", () => {
  it("exports and validates all pages, retains the frozen snapshot, removes rendered images and does not upload", async () => {
    const states: string[] = [];
    const source = snapshot();
    const job = await service.export(source, folder, (s) => states.push(s));
    expect(states).toEqual(["exporting", "validating", "ready"]);
    expect(job.pages).toBe(2);
    expect(job.pdfHash).toHaveLength(64);
    source.tasks[0].title = "changed later";
    expect((await service.load(job.id)).snapshot.tasks[0].title).toBe("Oppgave");
    expect(await readdir(service.directory(job.id))).not.toContain("rendered");
    expect(runner.mock.calls.some(([, args]) => args[1] === "upload")).toBe(false);
  });
  it("stops after a PDF generation failure, with no rendering or sending", async () => {
    renderer.mockRejectedValueOnce(new Error("PDF-generering mislyktes"));
    const source = snapshot();
    await expect(service.export(source, folder)).rejects.toThrow("PDF-generering");
    expect((await service.load(source.id)).state).toBe("error");
    expect(runner).not.toHaveBeenCalled();
  });
  it("allows local preview without upload authentication", async () => {
    await service.export(snapshot(), folder);
    expect(runner.mock.calls.some(([, args]) => args[0] === "cloud")).toBe(false);
  });
  it("rejects a missing rendered page", async () => {
    const original = runner.getMockImplementation()!;
    runner.mockImplementation(async (exe, args, opts) => {
      const result = await original(exe, args, opts);
      if (args[0] === "-png") await rm(path.join(path.dirname(args.at(-1)!), "page-2.png"));
      return result;
    });
    await expect(service.export(snapshot(), folder)).rejects.toThrow("mangler renderte");
  });
  it("blocks a second export while another command instance is exporting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = runner.getMockImplementation()!;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    runner.mockImplementation(async (exe, args, opts) => {
      if (args.length === 1) {
        entered();
        await gate;
      }
      return original(exe, args, opts);
    });
    const first = service.export(snapshot(), folder);
    await started;
    await expect(
      new DailyPlanService(service.root, prefs, renderer, runner).export(snapshot(), folder),
    ).rejects.toThrow("pågår allerede");
    release();
    await first;
  });
});

describe("upload without duplicate sends", () => {
  it("sends exactly the previewed PDF and folder and persists the returned document ID", async () => {
    const job = await service.export(snapshot(), folder);
    const result = await service.send(job.id);
    expect(result.state).toBe("sent");
    expect(result.documentId).toBe(documentId);
    const args = runner.mock.calls.find(([, a]) => a[1] === "upload")![1];
    expect(args).toContain(service.pdfPath(job));
    expect(args[args.indexOf("--parent") + 1]).toBe(folder.id);
    expect(args[0]).toBe("cloud");
    expect(args).not.toContain("--json");
    await expect(new DailyPlanService(service.root, prefs, renderer, runner).send(job.id)).rejects.toThrow(
      "kan ikke sendes igjen",
    );
    expect(runner.mock.calls.filter(([, a]) => a[1] === "upload")).toHaveLength(1);
  });
  it("blocks a PDF modified after preview", async () => {
    const job = await service.export(snapshot(), folder);
    await writeFile(service.pdfPath(job), "changed");
    await expect(service.send(job.id)).rejects.toThrow("endret etter forhåndsvisningen");
    expect(runner.mock.calls.some(([, a]) => a[1] === "upload")).toBe(false);
  });
  it.each(["timeout", "unknown response"])("never automatically retries an uncertain upload: %s", async (failure) => {
    const job = await service.export(snapshot(), folder);
    runner.mockResolvedValueOnce({ code: 0, stdout: "upload: supported", stderr: "" });
    if (failure === "timeout") runner.mockRejectedValueOnce(new Error("network error including secret"));
    else runner.mockResolvedValueOnce({ code: 0, stdout: "Uploaded without document ID", stderr: "" });
    const result = await service.send(job.id);
    expect(result.state).toBe("uncertain");
    expect(result.error).not.toContain("secret");
    await expect(service.send(job.id)).rejects.toThrow("kan ikke sendes igjen");
    expect(runner.mock.calls.filter(([, a]) => a[1] === "upload")).toHaveLength(1);
  });
  it("allows a deliberate retry when authentication fails before upload starts", async () => {
    const job = await service.export(snapshot(), folder);
    runner.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "not logged in",
    });
    const result = await service.send(job.id);
    expect(result.state).toBe("ready");
    expect(result.error).toContain("rm2 cloud login");
    expect((await service.send(job.id)).state).toBe("sent");
  });
  it("keeps an interrupted sending state non-retryable after restart", async () => {
    const job = await service.export(snapshot(), folder);
    const file = path.join(service.directory(job.id), "job.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    record.state = "sending";
    await writeFile(file, JSON.stringify(record));
    await expect(service.send(job.id)).rejects.toThrow("kan ikke sendes igjen");
  });
});

it("rejects truncated PNG output even when the renderer exits successfully", async () => {
  const original = runner.getMockImplementation()!;
  runner.mockImplementation(async (exe, args, opts) => {
    const result = await original(exe, args, opts);
    if (args[0] === "-png") await writeFile(path.join(path.dirname(args.at(-1)!), "page-1.png"), png.subarray(0, 30));
    return result;
  });
  await expect(service.export(snapshot(), folder)).rejects.toThrow("kunne ikke rendres som PNG");
});
it("expires job files after seven days on next use, preserving recent jobs", async () => {
  const old = await service.export(snapshot(), folder);
  old.createdAt = new Date(Date.now() - 8 * 86400000).toISOString();
  await writeFile(path.join(service.directory(old.id), "job.json"), JSON.stringify(old));
  const recent = await service.export(snapshot(), folder);
  expect((await service.latest())?.id).toBe(recent.id);
  expect(await readdir(service.root)).not.toContain(old.id);
});
it("blocks concurrent send attempts before a second upload can start", async () => {
  const job = await service.export(snapshot(), folder);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const original = runner.getMockImplementation()!;
  runner.mockImplementation(async (exe, args, opts) => {
    if (args[1] === "upload") {
      entered();
      await gate;
    }
    return original(exe, args, opts);
  });
  const first = service.send(job.id);
  await started;
  await expect(new DailyPlanService(service.root, prefs, renderer, runner).send(job.id)).rejects.toThrow(
    "pågår allerede",
  );
  release();
  expect((await first).state).toBe("sent");
  expect(runner.mock.calls.filter(([, args]) => args[1] === "upload")).toHaveLength(1);
});
it("retains a retryable preview if the login check itself times out before upload", async () => {
  const job = await service.export(snapshot(), folder);
  runner.mockRejectedValueOnce(new Error("Prosessen brukte for lang tid"));
  await expect(service.send(job.id)).rejects.toThrow("for lang tid");
  expect((await service.load(job.id)).state).toBe("ready");
  expect(runner.mock.calls.some(([, args]) => args[1] === "upload")).toBe(false);
});

describe("folder creation", () => {
  const item = { kind: "folder", id: "read-hash", upload_parent_id: folder.id, name: folder.name, parent: "" };
  const response = (data: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ protocol_version: 1, ok: true, data }),
    stderr: "",
  });
  beforeEach(() => {
    runner.mockImplementation(async (_exe, args) => {
      if (args[1] === "capabilities") return response({ features: ["create_folder", "fresh_listing"] });
      if (args[1] === "list") return response([]);
      return response(item);
    });
  });
  const creates = () => runner.mock.calls.filter(([, args]) => args[1] === "mkdir");

  it("returns the confirmed upload UUID, keeps shell characters literal and clears its pending marker", async () => {
    const name = "--Dagsplaner $(echo test) æøå";
    expect(await service.createFolder(` ${name} `)).toEqual({ ...folder, parent: "" });
    expect(creates()[0][1]).toEqual(["cloud", "mkdir", "--app-json", "--", name]);
    expect(await readdir(service.root)).toEqual([]);
  });
  it.each(["", "  ", "A/B", "A\\B", "A\nB", "x".repeat(256)])(
    "rejects invalid names before any process starts: %s",
    async (name) => {
      await expect(service.createFolder(name)).rejects.toThrow("mappenavn");
      expect(runner).not.toHaveBeenCalled();
    },
  );
  it("explains an older CLI and never attempts creation", async () => {
    runner.mockResolvedValueOnce(response({ features: ["app_json"] }));
    await expect(service.createFolder("Dagsplaner")).rejects.toThrow("Oppdater rm2");
    expect(creates()).toHaveLength(0);
    expect(await readdir(service.root)).toEqual([]);
  });
  it("allows another attempt after a definite login failure without exposing raw errors", async () => {
    const original = runner.getMockImplementation()!;
    runner.mockImplementation(async (exe, args, opts) =>
      args[1] === "mkdir"
        ? {
            code: 1,
            stdout: JSON.stringify({
              protocol_version: 1,
              ok: false,
              error: { code: "read_auth", message: "secret-token" },
            }),
            stderr: "",
          }
        : original(exe, args, opts),
    );
    await expect(service.createFolder("Dagsplaner")).rejects.toThrow("rm2 cloud web-login");
    expect(await readdir(service.root)).toEqual([]);
    runner.mockImplementation(original);
    expect((await service.createFolder("Dagsplaner")).id).toBe(folder.id);
  });
  it.each(["timeout", "bad-json", "missing-id", "server"])(
    "blocks further writes after an uncertain %s, including after reopening the command",
    async (outcome) => {
      const original = runner.getMockImplementation()!;
      runner.mockImplementation(async (exe, args, opts) => {
        if (args[1] !== "mkdir") return original(exe, args, opts);
        if (outcome === "timeout") throw new Error("secret-token");
        if (outcome === "bad-json") return { code: 1, stdout: "secret-token", stderr: "" };
        if (outcome === "missing-id") return response({ ...item, upload_parent_id: null });
        return {
          code: 1,
          stdout: JSON.stringify({
            protocol_version: 1,
            ok: false,
            error: { code: "folder_uncertain", may_have_uploaded: true },
          }),
          stderr: "",
        };
      });
      await expect(service.createFolder("Dagsplaner")).rejects.toThrow("kunne ikke bekreftes");
      const reopened = new DailyPlanService(service.root, prefs, renderer, runner);
      await expect(reopened.createFolder("dagsplaner")).rejects.toThrow("kunne ikke bekreftes");
      expect(creates()).toHaveLength(1);
      expect((await readdir(service.root)).filter((name) => name.startsWith("folder-create-"))).toHaveLength(1);
    },
  );
  it("recovers an uncertain creation only from a fresh, unique root folder without another write", async () => {
    const original = runner.getMockImplementation()!;
    runner.mockImplementation(async (exe, args, opts) => {
      if (args[1] === "mkdir") throw new Error("timeout");
      return original(exe, args, opts);
    });
    await expect(service.createFolder("Dagsplaner")).rejects.toThrow("kunne ikke bekreftes");
    runner.mockImplementation(async (exe, args, opts) =>
      args[1] === "list"
        ? response([{ ...item, upload_parent_id: documentId, parent: "other-parent" }, item])
        : original(exe, args, opts),
    );
    expect(await service.createFolder("dagsplaner")).toEqual({ ...folder, parent: "" });
    expect(creates()).toHaveLength(1);
    expect(await readdir(service.root)).toEqual([]);
  });
  it("blocks a second command instance while creation is in progress", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const original = runner.getMockImplementation()!;
    runner.mockImplementation(async (exe, args, opts) => {
      if (args[1] === "mkdir") {
        entered();
        await gate;
      }
      return original(exe, args, opts);
    });
    const first = service.createFolder("Dagsplaner");
    await started;
    await expect(
      new DailyPlanService(service.root, prefs, renderer, runner).createFolder("Dagsplaner"),
    ).rejects.toThrow("pågår allerede");
    release();
    await first;
    expect(creates()).toHaveLength(1);
  });
});

it("requires a fresh sync-backed folder listing, including canonical destination IDs", async () => {
  runner.mockResolvedValueOnce({
    code: 0,
    stdout: JSON.stringify({
      protocol_version: 1,
      ok: true,
      data: [{ kind: "folder", upload_parent_id: folder.id, name: "Dagsplaner", parent: "" }],
    }),
    stderr: "",
  });
  expect((await service.folders())[0].id).toBe(folder.id);
  expect(runner.mock.calls[0][1]).toEqual(["cloud", "list", "--kind", "folder", "--fresh", "--app-json"]);
});
it("explains when fresh folder listing needs renewed upload authentication", () => {
  expect(() =>
    parseFolders(JSON.stringify({ protocol_version: 1, ok: false, error: { code: "upload_auth" } })),
  ).toThrow("rm2 cloud login");
});
