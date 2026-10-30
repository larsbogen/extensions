import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireFocusLock, writeFocusJson } from "../src/focus/storage";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "focus-lock-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("focus command recovery", () => {
  it("suppresses a live overlapping command but acquires again after release", async () => {
    const lock = join(directory, "command.lock");
    const release = await acquireFocusLock(lock);
    expect(release).toBeDefined();
    expect(await acquireFocusLock(lock)).toBeUndefined();
    await release!();
    const next = await acquireFocusLock(lock);
    expect(next).toBeDefined();
    await next!();
  });
  it("recovers a crashed command without allowing competing retries to remove the new lock", async () => {
    const lock = join(directory, "command.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647 }));
    const original = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 2147483647) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return original(pid, signal);
    });
    const releases = await Promise.all([acquireFocusLock(lock), acquireFocusLock(lock)]);
    expect(releases.filter(Boolean)).toHaveLength(1);
    await releases.find(Boolean)!();
    const retry = await acquireFocusLock(lock);
    expect(retry).toBeDefined();
    await retry!();
  });
  it("recovers an old lock whose process died before writing its owner", async () => {
    const lock = join(directory, "command.lock");
    await mkdir(lock);
    await utimes(lock, new Date(0), new Date(0));
    const release = await acquireFocusLock(lock);
    expect(release).toBeDefined();
    await release!();
  });
  it("atomically replaces private receipts and leaves no task-owned temporary files", async () => {
    const file = join(directory, "intent.json");
    await writeFocusJson(file, { started: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ started: true });
    await writeFocusJson(file, { started: true, confirmed: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ started: true, confirmed: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["intent.json"]);
  });
});
