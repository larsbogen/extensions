import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Task } from "../src/api";
import {
  activeEntries,
  addTaskToPlan,
  carryCandidates,
  createWorkday,
  eligibleTasks,
  isSuggested,
  markCompleted,
  moveEntry,
  nextEntry,
  reconcilePlan,
  removeEntry,
  toggleTopThree,
} from "../src/workday/model";
import { WorkdayStore } from "../src/workday/store";

const now = new Date("2026-10-30T10:00:00Z");
const projects = [
  { id: "p", name: "Arbeid" },
  { id: "q", name: "Hjem" },
] as Project[];
function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    content: id,
    project_id: "p",
    due: null,
    deadline: null,
    checked: false,
    is_deleted: false,
    responsible_uid: null,
    ...extra,
  } as Task;
}
const recurring = (date: string) =>
  task("repeat", { due: { date, timezone: null, is_recurring: true } as Task["due"] });
const base = () => createWorkday("me", "2026-10-30");
const add = (plan: ReturnType<typeof base>, item: Task) => addTaskToPlan(plan, item, projects, now);

describe("a shared, explicitly selected workday", () => {
  it("allows undated and future own/unassigned tasks but excludes collaborators and inactive projects", () => {
    expect(
      eligibleTasks(
        [
          task("undated"),
          task("future", { due: { date: "2027-01-01" } as Task["due"] }),
          task("mine", { responsible_uid: "me" }),
          task("other", { responsible_uid: "other" }),
          task("deleted", { is_deleted: true }),
          task("archived", { project_id: "archive" }),
          task("done", { checked: true }),
        ],
        [...projects, { id: "archive", is_archived: true } as Project],
        "me",
      ).map((t) => t.id),
    ).toEqual(["undated", "future", "mine"]);
    expect(isSuggested(task("deadline", { deadline: { date: "2026-10-29" } as Task["deadline"] }), "2026-10-30")).toBe(
      true,
    );
    expect(isSuggested(task("offset", { due: { date: "2026-10-30T23:30:00Z" } as Task["due"] }), "2026-10-30")).toBe(
      false,
    );
  });
  it("preserves manual cross-project order and keeps top three independent", () => {
    let plan = add(
      add(add(base(), task("child", { parent_id: "parent" })), task("other", { project_id: "q" })),
      task("parent"),
    );
    const ids = plan.entries.map((entry) => entry.id);
    plan = toggleTopThree(plan, ids[2]);
    expect(activeEntries(plan).map((entry) => entry.taskId)).toEqual(["child", "other", "parent"]);
    plan = moveEntry(plan, ids[2], -1);
    expect(activeEntries(plan).map((entry) => entry.taskId)).toEqual(["child", "parent", "other"]);
    expect(plan.topThree).toEqual([ids[2]]);
    expect(nextEntry(plan, ids[2])?.taskId).toBe("other");
    expect(nextEntry(plan, ids[1])).toBeUndefined();
  });
  it("caps top three, avoids duplicate selection and keeps removed anchors for the queue", () => {
    let plan = ["a", "b", "c", "d"].reduce((value, id) => add(value, task(id)), base());
    for (const entry of plan.entries.slice(0, 3)) plan = toggleTopThree(plan, entry.id);
    expect(() => toggleTopThree(plan, plan.entries[3].id)).toThrow("tre");
    expect(add(plan, task("a"))).toEqual(plan);
    const removed = removeEntry(plan, plan.entries[1].id);
    expect(removed.topThree).not.toContain(plan.entries[1].id);
    expect(nextEntry(removed, plan.entries[1].id)?.taskId).toBe("c");
    expect(activeEntries(removed).map((entry) => entry.taskId)).toEqual(["a", "c", "d"]);
  });
  it("does not silently queue a recurring task's next occurrence", () => {
    const plan = add(base(), recurring("2026-10-30"));
    const entry = plan.entries[0];
    const nextTask = recurring("2026-10-31");
    expect(activeEntries(reconcilePlan(plan, [nextTask], projects, "me"))).toEqual([]);
    const completed = reconcilePlan(plan, [nextTask], projects, "me", [
      { taskId: "repeat", completedAt: "2026-10-30T10:01:00Z" },
    ]);
    expect(completed.entries[0].status).toBe("completed");
    const explicitlyAdded = addTaskToPlan(completed, nextTask, projects, new Date("2026-10-30T10:02:00Z"));
    expect(activeEntries(explicitlyAdded)).toHaveLength(1);
    expect(activeEntries(explicitlyAdded)[0].id).not.toBe(entry.id);
    expect(
      activeEntries(
        reconcilePlan(explicitlyAdded, [nextTask], projects, "me", [
          { taskId: "repeat", completedAt: "2026-10-30T10:01:00Z" },
        ]),
      ),
    ).toHaveLength(1);
  });
  it("refreshes metadata without selection changes and distinguishes unavailable from completed", () => {
    const plan = ["a", "b", "c"].reduce((value, id) => add(value, task(id)), base());
    const result = reconcilePlan(
      plan,
      [task("a", { content: "New title", project_id: "q" }), task("b", { checked: true }), task("new")],
      projects,
      "me",
    );
    expect(result.entries.map((entry) => entry.taskId)).toEqual(["a", "b", "c"]);
    expect(result.entries[0]).toMatchObject({ title: "New title", projectName: "Hjem", status: "active" });
    expect(result.entries[1].status).toBe("completed");
    expect(result.entries[2].status).toBe("unavailable");
    expect(() => reconcilePlan(plan, [], [], "other")).toThrow("annen");
    expect(markCompleted(result, plan.entries[0].id).entries[0].status).toBe("completed");
  });
  it("offers only unfinished same-occurrence carry candidates and never copies automatically", () => {
    const previous = add(add(add(base(), task("a")), recurring("2026-10-30")), task("done"));
    const plan = markCompleted(previous, previous.entries[2].id);
    expect(
      carryCandidates(plan, [task("a"), recurring("2026-10-31"), task("done")], projects, "me").map((t) => t.id),
    ).toEqual(["a"]);
    expect(createWorkday("me", "2026-10-31").entries).toEqual([]);
    expect(carryCandidates(plan, [task("a")], projects, "other")).toEqual([]);
  });
});

describe("durable account/day storage", () => {
  let directory: string;
  let store: WorkdayStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "todoist-workday-"));
    store = new WorkdayStore(directory, 300);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("persists order/top three, increments only changed revisions and separates accounts/days", async () => {
    const first = await store.update("me", "2026-10-30", (plan) => add(plan, task("a")));
    const second = await store.update("me", "2026-10-30", (plan) => toggleTopThree(plan, first.entries[0].id));
    expect(second.revision).toBe(2);
    expect((await store.update("me", "2026-10-30", (plan) => plan)).revision).toBe(2);
    expect(await new WorkdayStore(directory).read("me", "2026-10-30")).toEqual(second);
    expect(await store.read("other", "2026-10-30")).toBeUndefined();
    expect(await store.read("me", "2026-10-31")).toBeUndefined();
    expect(await store.latestPrevious("me", "2026-11-02")).toEqual(second);
    expect(await store.latestPrevious("me", "2026-10-30")).toBeUndefined();
  });
  it("serializes independent command instances without losing updates", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        new WorkdayStore(directory).update("me", "2026-10-30", (plan) => add(plan, task(String(i)))),
      ),
    );
    const plan = (await store.read("me", "2026-10-30"))!;
    expect(new Set(plan.entries.map((entry) => entry.taskId)).size).toBe(8);
    expect(plan.revision).toBe(8);
    const account = join(directory, createHash("sha256").update("me").digest("hex"));
    expect(await readdir(account)).toEqual(["2026-10-30.json"]);
  });
  it("preserves corrupt/unsupported files and releases a lock after a failed mutation", async () => {
    const saved = await store.update("me", "2026-10-30", (plan) => add(plan, task("a")));
    await expect(
      store.update("me", "2026-10-30", () => {
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await store.read("me", "2026-10-30")).toEqual(saved);
    const account = join(directory, createHash("sha256").update("me").digest("hex"));
    const file = join(account, "2026-10-30.json");
    await writeFile(file, '{"version":99}');
    await expect(store.update("me", "2026-10-30", (plan) => plan)).rejects.toThrow("beholdt");
    expect(await readFile(file, "utf8")).toBe('{"version":99}');
    expect(await readdir(account)).toEqual(["2026-10-30.json"]);
  });
  it("never steals a live lock or accepts an invalid date/account mutation", async () => {
    await expect(store.read("me", "2026-02-30")).rejects.toThrow();
    await expect(store.update("me", "2026-10-30", (plan) => ({ ...plan, accountId: "other" }))).rejects.toThrow();
    const account = join(directory, createHash("sha256").update("me").digest("hex"));
    const lock = join(account, "2026-10-30.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
    await expect(store.update("me", "2026-10-30", (plan) => plan)).rejects.toThrow("annen kommando");
    expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);
  });
});
