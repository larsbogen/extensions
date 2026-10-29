import { it, expect, vi, afterEach } from "vitest";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
import { execFile } from "node:child_process";
import {
  ServiceControl,
  parseStatus,
  readLog,
  literalLog,
  type Status,
} from "../src/service-control";
const stopped: Status = {
  version: 1,
  service: "library",
  state: "stopped",
  url: null,
  logPath: "/tmp/test.log",
  canStop: false,
};
const ready: Status = {
  ...stopped,
  state: "ready",
  url: "http://127.0.0.1:9876",
  canStop: true,
};
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const d of directories.splice(0))
    await rm(d, { recursive: true, force: true });
});
async function temporary() {
  const d = await mkdtemp(join(tmpdir(), "raycast-services-"));
  directories.push(d);
  return d;
}
it("status only calls the passive JSON command with a 20 second bound", async () => {
  const root = await temporary();
  await writeFile(join(root, "control.py"), "fixture");
  vi.mocked(execFile).mockImplementation(((
    _f: unknown,
    _a: unknown,
    _o: unknown,
    cb: (e: null, s: string) => void,
  ) => {
    cb(null, JSON.stringify(stopped));
    return { stdin: { end: vi.fn() } };
  }) as never);
  const c = new ServiceControl({
    libraryPath: root,
    pythonPath: process.execPath,
  });
  expect(await c.status("library")).toEqual(stopped);
  expect(vi.mocked(execFile).mock.calls[0][1]).toEqual([
    "control.py",
    "status",
    "--json",
  ]);
  expect(vi.mocked(execFile).mock.calls[0][2]).toMatchObject({
    timeout: 20000,
  });
});
it("reports missing projects and runtimes independently without starting anything", async () => {
  const root = await temporary();
  const c = new ServiceControl({
    libraryPath: join(root, "missing"),
    atlasPath: root,
    nodePath: join(root, "node"),
  });
  expect((await c.status("library")).message).toContain("prosjektmappen");
  expect((await c.status("atlas")).message).toContain("kjøretiden");
  expect(execFile).not.toHaveBeenCalled();
});
it("rejects old protocols, foreign identities and nonlocal URLs", () => {
  for (const raw of [
    "Turatlas kjører",
    JSON.stringify({ ...ready, version: 2 }),
    JSON.stringify({ ...ready, service: "other" }),
    JSON.stringify({ ...ready, url: "https://example.com" }),
    JSON.stringify({ ...stopped, canStop: true }),
  ])
    expect(() => parseStatus(raw, "library")).toThrow();
});
it("opens only after start and a new ready confirmation", async () => {
  const c = new ServiceControl({});
  const statuses = vi
    .spyOn(c, "status")
    .mockResolvedValueOnce(stopped)
    .mockResolvedValueOnce(ready);
  const browser = vi.fn();
  vi.mocked(execFile).mockImplementation(((
    _f: unknown,
    _a: unknown,
    _o: unknown,
    cb: (e: null, s: string) => void,
  ) => {
    expect(browser).not.toHaveBeenCalled();
    cb(null, "done");
    return {};
  }) as never);
  expect(
    (await c.perform("library", "start", browser, true)).error,
  ).toBeUndefined();
  expect(statuses).toHaveBeenCalledTimes(2);
  expect(browser).toHaveBeenCalledWith(ready.url);
  expect(vi.mocked(execFile).mock.calls[0][1]).toEqual([
    "control.py",
    "start",
    "--no-open",
  ]);
  expect(vi.mocked(execFile).mock.calls[0][2]).toMatchObject({
    timeout: 90000,
  });
});
it("reuses ready services and refuses unknown starts and externally owned stops", async () => {
  const c = new ServiceControl({});
  const statuses = vi.spyOn(c, "status").mockResolvedValue(ready);
  const browser = vi.fn();
  await c.perform("library", "start", browser, true);
  expect(browser).toHaveBeenCalledOnce();
  expect(execFile).not.toHaveBeenCalled();
  statuses.mockResolvedValue({ ...ready, canStop: false });
  expect((await c.perform("library", "stop", browser)).error).toBeTruthy();
  statuses.mockResolvedValue({ ...stopped, state: "unknown" });
  expect(
    (await c.perform("library", "start", browser, true)).error,
  ).toBeTruthy();
  expect(execFile).not.toHaveBeenCalled();
});
it("checks once after a timeout, never retries or opens, and prevents double activation", async () => {
  const c = new ServiceControl({});
  const statuses = vi.spyOn(c, "status").mockResolvedValue(stopped);
  const browser = vi.fn();
  let finish: (e: Error) => void = () => {};
  vi.mocked(execFile).mockImplementation(((
    _f: unknown,
    _a: unknown,
    _o: unknown,
    cb: (e: Error) => void,
  ) => {
    finish = cb;
    return {};
  }) as never);
  const first = c.perform("library", "start", browser, true);
  await expect(c.perform("library", "start", browser)).rejects.toThrow("pågår");
  await vi.waitFor(() => expect(execFile).toHaveBeenCalledOnce());
  finish(Object.assign(new Error("timeout"), { killed: true }));
  expect((await first).error).toContain("Tidsgrensen");
  expect(statuses).toHaveBeenCalledTimes(2);
  expect(execFile).toHaveBeenCalledOnce();
  expect(browser).not.toHaveBeenCalled();
});
it("stops using the existing command and confirms the result", async () => {
  const c = new ServiceControl({});
  vi.spyOn(c, "status")
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce(stopped);
  vi.mocked(execFile).mockImplementation(((
    _f: unknown,
    _a: unknown,
    _o: unknown,
    cb: (e: null, s: string) => void,
  ) => {
    cb(null, "done");
    return {};
  }) as never);
  expect((await c.perform("library", "stop", vi.fn())).status.state).toBe(
    "stopped",
  );
  expect(vi.mocked(execFile).mock.calls[0][1]).toEqual(["control.py", "stop"]);
});
it("tails bounded logs and reopens rotated files, preserving literal text", async () => {
  const root = await temporary(),
    file = join(root, "server.log");
  await writeFile(
    file,
    "x".repeat(100000) +
      "\n" +
      Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n"),
  );
  const tail = await readLog(file);
  expect(tail.split("\n")).toHaveLength(200);
  expect(tail.startsWith("line 50")).toBe(true);
  expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(65536);
  await rename(file, file + ".1");
  await writeFile(
    file,
    "\u001b[31m![image](https://example.test)\u0000\n```\nhello",
  );
  const log = await readLog(file);
  expect(log).not.toContain("\u001b");
  expect(log).not.toContain("\u0000");
  expect(literalLog(log)).toMatch(/^````text/);
  await writeFile(file, "");
  expect(await readLog(file)).toBe("");
  await rm(file);
  await expect(readLog(file)).rejects.toMatchObject({ code: "ENOENT" });
  await symlink(file + ".1", file);
  await expect(readLog(file)).rejects.toThrow();
  await rm(file);
  await mkdir(file);
  await expect(readLog(file)).rejects.toThrow("vanlig fil");
});
