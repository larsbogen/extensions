import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SyncData, Task } from "../src/api";

const dependencies = vi.hoisted(() => ({ initialSync: vi.fn(), update: vi.fn() }));
vi.mock("../src/api", () => ({ initialSync: dependencies.initialSync }));
vi.mock("../src/helpers/withTodoistApi", () => ({ getTodoistApi: () => ({}) }));
vi.mock("../src/workday/runtime", () => ({ getWorkdayStore: () => ({ update: dependencies.update }) }));

import { addTaskToPlan, createWorkday, type WorkdayPlan } from "../src/workday/model";
import { addToToday, editWorkday } from "../src/workday/service";

const day = "2026-10-30";
const project = { id: "p", name: "Arbeid" } as Project;
const task = { id: "t", content: "Oppgave", project_id: "p", due: null, responsible_uid: null } as Task;
const snapshot = (accountId = "me") =>
  ({ user: { id: accountId }, projects: [project], items: [] }) as unknown as SyncData;

describe("workday edits use fresh account and day guards", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("adds the latest duration from Todoist for the selected occurrence", async () => {
    const selected = {
      ...task,
      due: { date: day, is_recurring: true, timezone: null } as Task["due"],
      duration: { amount: 5, unit: "minute" } as const,
    };
    const current = { ...selected, duration: { amount: 25, unit: "minute" } as const };
    dependencies.initialSync.mockResolvedValue({ ...snapshot(), items: [current] });
    dependencies.update.mockImplementation(async (_accountId, _day, mutate: (value: WorkdayPlan) => WorkdayPlan) =>
      mutate(createWorkday("me", day)),
    );
    const result = await addToToday(selected, "me", day);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ taskId: task.id, duration: current.duration });
  });

  it("rejects adding a different recurring occurrence with the same task id before writing", async () => {
    const selected = { ...task, due: { date: day, is_recurring: true, timezone: null } as Task["due"] };
    const current = { ...selected, due: { ...selected.due, date: "2026-10-31" } };
    dependencies.initialSync.mockResolvedValue({ ...snapshot(), items: [current] });
    await expect(addToToday(selected, "me", day)).rejects.toThrow("annen forekomst");
    expect(dependencies.update).not.toHaveBeenCalled();
  });

  it("rejects an old account's open view before invoking its mutation or writer", async () => {
    dependencies.initialSync.mockResolvedValue(snapshot("other"));
    const mutation = vi.fn((plan: WorkdayPlan) => plan);
    await expect(editWorkday("me", day, mutation)).rejects.toThrow("kontoen er endret");
    expect(mutation).not.toHaveBeenCalled();
    expect(dependencies.update).not.toHaveBeenCalled();
  });

  it("rejects an edit when Oslo midnight passes while fetching fresh data", async () => {
    vi.setSystemTime(new Date("2026-10-30T22:59:59Z"));
    dependencies.initialSync.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-10-30T23:00:01Z"));
      return snapshot();
    });
    await expect(editWorkday("me", day, (plan) => plan)).rejects.toThrow("ny dag");
    expect(dependencies.update).not.toHaveBeenCalled();
  });

  it("keeps entries concurrently added after the fetch began when applying a valid edit", async () => {
    const plan = addTaskToPlan(createWorkday("me", day), task, [project], new Date("2026-10-30T10:00:01Z"));
    dependencies.initialSync.mockResolvedValue(snapshot());
    dependencies.update.mockImplementation(async (_accountId, _day, mutate: (value: WorkdayPlan) => WorkdayPlan) =>
      mutate(plan),
    );
    const result = await editWorkday("me", day, (value) => ({ ...value, topThree: [value.entries[0].id] }));
    expect(result.entries[0].status).toBe("active");
    expect(result.topThree).toEqual([plan.entries[0].id]);
    expect(dependencies.update).toHaveBeenCalledWith("me", day, expect.any(Function));
  });

  it("does not write when Todoist returns incomplete data", async () => {
    dependencies.initialSync.mockResolvedValue({ user: { id: "me" } });
    await expect(editWorkday("me", day, (plan) => plan)).rejects.toThrow("ufullstendige data");
    expect(dependencies.update).not.toHaveBeenCalled();
  });
});
