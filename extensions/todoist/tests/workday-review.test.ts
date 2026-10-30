import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Task } from "../src/api";
import { activeEntries, addTaskToPlan, createWorkday, reconcilePlan } from "../src/workday/model";
import { WorkdayStore } from "../src/workday/store";

const day = "2026-10-30";
const projects = [{ id: "p", name: "Arbeid" }] as Project[];
const task = (id: string) => ({ id, content: id, project_id: "p", due: null, responsible_uid: null }) as Task;
const deadPid = 987650;

describe("workday concurrency review regressions", () => {
  let directory: string;
  let lock: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "todoist-workday-review-"));
    lock = join(directory, createHash("sha256").update("me").digest("hex"), `${day}.lock`);
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal !== 0) throw new Error("This test only allows read-only PID checks");
      if (pid === deadPid) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      return kill(pid, signal);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function owner(path: string, pid: number) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "owner.json"), JSON.stringify({ pid }));
  }

  it("recovers crashed lock owners without losing simultaneous edits", async () => {
    await owner(lock, deadPid);
    const stores = Array.from({ length: 8 }, () => new WorkdayStore(directory, 2000));
    await Promise.all(
      stores.map((store, index) =>
        store.update("me", day, (plan) => addTaskToPlan(plan, task(String(index)), projects)),
      ),
    );
    const plan = await stores[0].read("me", day);
    expect(plan?.revision).toBe(8);
    expect(
      activeEntries(plan!)
        .map((entry) => entry.taskId)
        .sort(),
    ).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });

  it("never deletes a live recovery owner while recovering its crashed ancestor", async () => {
    await owner(lock, deadPid);
    const nested = join(lock, "recovery");
    await owner(nested, process.pid);
    const store = new WorkdayStore(directory, 60);
    await expect(store.update("me", day, (plan) => addTaskToPlan(plan, task("blocked"), projects))).rejects.toThrow(
      "annen kommando",
    );
    expect(JSON.parse(await readFile(join(nested, "owner.json"), "utf8"))).toEqual({ pid: process.pid });
    expect(await store.read("me", day)).toBeUndefined();
  });

  it("does not invalidate an entry added after the remote snapshot started", () => {
    let plan = addTaskToPlan(createWorkday("me", day), task("old"), projects, new Date("2026-10-30T09:00:00Z"));
    plan = addTaskToPlan(plan, task("late"), projects, new Date("2026-10-30T10:01:00Z"));
    const reconciled = reconcilePlan(plan, [], projects, "me", [], "2026-10-30T10:00:00Z");
    expect(reconciled.entries.find((entry) => entry.taskId === "old")?.status).toBe("unavailable");
    expect(reconciled.entries.find((entry) => entry.taskId === "late")?.status).toBe("active");
    expect(plan.entries.every((entry) => entry.status === "active")).toBe(true);
  });
});
