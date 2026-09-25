import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/api";
import { duplicateTaskPayload } from "../src/helpers/duplicateTask";
import { keepRecurrenceDuePayload, rescheduleToTodayPayload } from "../src/helpers/repeat";
import { mergeSyncEntities } from "../src/helpers/sync";

vi.mock("@raycast/api", () => ({ Icon: {} }));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "a",
    content: "Take medicine",
    description: "Details",
    project_id: "p",
    section_id: "s",
    parent_id: "parent",
    child_order: 0,
    labels: ["health"],
    priority: 4,
    responsible_uid: "person",
    due: null,
    deadline: null,
    ...overrides,
  } as Task;
}

describe("task duplication", () => {
  it("preserves recurrence, next occurrence, fixed timezone, deadline and duration", () => {
    const original = task({
      due: {
        date: "2026-09-25T08:00:00",
        string: "every! day at 8am",
        lang: "en",
        timezone: "Europe/Oslo",
        is_recurring: true,
      },
      deadline: { date: "2026-09-30", lang: "en", timezone: null },
      duration: { amount: 30, unit: "minute" },
    });
    const copy = duplicateTaskPayload(original);
    expect(copy).toMatchObject({
      content: original.content,
      description: original.description,
      project_id: "p",
      section_id: "s",
      parent_id: "parent",
      child_order: 0,
      labels: ["health"],
      priority: 4,
      responsible_uid: "person",
      due: { date: "2026-09-25T08:00:00", string: "every! day at 8am", timezone: "Europe/Oslo", lang: "en" },
      deadline: { date: "2026-09-30" },
      duration: { amount: 30, unit: "minute" },
    });
    expect(copy).not.toHaveProperty("id");
    expect(copy.labels).not.toBe(original.labels);
    expect(copy.duration).not.toBe(original.duration);
  });

  it("preserves all-day recurrence without converting it to a timestamp", () => {
    const copy = duplicateTaskPayload(
      task({ due: { date: "2026-09-25", string: "every weekday", lang: "en", timezone: null, is_recurring: true } }),
    );
    expect(copy.due).toEqual({ date: "2026-09-25", string: "every weekday", lang: "en" });
  });

  it("does not reparse a stale relative expression on a one-off task", () => {
    const copy = duplicateTaskPayload(
      task({ due: { date: "2026-09-25", string: "tomorrow", lang: "en", timezone: null, is_recurring: false } }),
    );
    expect(copy.due).toEqual({ date: "2026-09-25", lang: "en" });
  });

  it("omits absent paid fields so ordinary copies work on Free accounts", () => {
    const copy = duplicateTaskPayload(task({ duration: null }));
    expect(copy.due).toBeUndefined();
    expect(copy).not.toHaveProperty("deadline");
    expect(copy).not.toHaveProperty("duration");
  });
});

describe("sync entity merging", () => {
  it("keeps untouched entities and ignores empty incremental responses", () => {
    const original = [{ id: "a" }, { id: "b" }];
    expect(mergeSyncEntities(original, [])).toEqual(original);
  });

  it("removes deleted, archived and completed entities", () => {
    const previous = [{ id: "deleted" }, { id: "archived" }, { id: "completed" }, { id: "keep" }];
    expect(
      mergeSyncEntities(previous, [
        { id: "deleted", is_deleted: 1 },
        { id: "archived", is_archived: true },
        { id: "completed", checked: true },
      ]),
    ).toEqual([{ id: "keep" }]);
    expect(previous).toHaveLength(4);
  });

  it("replaces the active set for a full response, including an empty one", () => {
    expect(mergeSyncEntities([{ id: "stale" }], [{ id: "current" }], true)).toEqual([{ id: "current" }]);
    expect(mergeSyncEntities([{ id: "stale" }], [], true)).toEqual([]);
  });
});

describe("reschedule to today", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 25, 14, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the recurrence rule of an overdue daily task", () => {
    const due = { date: "2026-09-24", string: "every day", is_recurring: true } as Task["due"];
    expect(rescheduleToTodayPayload(task({ due }))).toEqual({ date: "2026-09-25", string: "every day" });
  });

  it("keeps the time of day of a timed recurring task", () => {
    const due = { date: "2026-09-24T09:00:00", string: "every day at 9", is_recurring: true } as Task["due"];
    expect(rescheduleToTodayPayload(task({ due }))).toEqual({ date: "2026-09-25T09:00:00", string: "every day at 9" });
  });

  it("sends only the date for a non-recurring task", () => {
    const due = { date: "2026-09-20", string: "20 Sep", is_recurring: false } as Task["due"];
    expect(rescheduleToTodayPayload(task({ due }))).toEqual({ date: "2026-09-25" });
  });
});

describe("AI due updates on recurring tasks", () => {
  const daily = task({ due: { date: "2026-09-24", string: "every day", is_recurring: true } as Task["due"] });
  const timed = task({
    due: { date: "2026-09-24T09:00:00", string: "every day at 9", is_recurring: true } as Task["due"],
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 25, 14, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the rule when the AI says today", () => {
    expect(keepRecurrenceDuePayload(daily, { string: "today" })).toEqual({ date: "2026-09-25", string: "every day" });
  });

  it("keeps the rule and the time of day for a date-only move", () => {
    expect(keepRecurrenceDuePayload(timed, { date: "2026-09-27" })).toEqual({
      date: "2026-09-27T09:00:00",
      string: "every day at 9",
    });
    expect(keepRecurrenceDuePayload(timed, { string: "Tomorrow" })).toEqual({
      date: "2026-09-26T09:00:00",
      string: "every day at 9",
    });
  });

  it("uses an explicit time as given", () => {
    expect(keepRecurrenceDuePayload(timed, { date: "2026-09-26T15:00:00" })).toEqual({
      date: "2026-09-26T15:00:00",
      string: "every day at 9",
    });
  });

  it("passes a new rule, a cleared date or an unknown phrase through to Todoist", () => {
    for (const due of [{ string: "every monday" }, { string: "no date" }, { string: "friday at 3pm", lang: "en" }]) {
      expect(keepRecurrenceDuePayload(daily, due)).toBe(due);
    }
  });

  it("leaves non-recurring tasks alone", () => {
    const due = { string: "today" };
    expect(
      keepRecurrenceDuePayload(task({ due: { date: "2026-09-20", is_recurring: false } as Task["due"] }), due),
    ).toBe(due);
  });
});
