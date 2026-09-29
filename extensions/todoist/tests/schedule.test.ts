import { describe, expect, it, vi } from "vitest";

import type { Task } from "../src/api";
import { getAPIDate } from "../src/helpers/dates";
import { rescheduleToDayPayload } from "../src/helpers/repeat";
import { getScheduleOptions } from "../src/helpers/schedule";

vi.mock("@raycast/api", () => ({ Icon: {} }));

function dates(now: Date, settings?: Parameters<typeof getScheduleOptions>[0]) {
  return Object.fromEntries(
    getScheduleOptions(settings, now).map(({ key, date }) => [key, date ? getAPIDate(date) : null]),
  );
}

describe("schedule shortcuts", () => {
  it("offers the dates shown in the app's Tuesday example, including month rollover", () => {
    expect(dates(new Date(2026, 8, 29, 23, 30))).toEqual({
      today: "2026-09-29",
      tomorrow: "2026-09-30",
      "later-this-week": "2026-10-01",
      weekend: "2026-10-03",
      "next-week": "2026-10-05",
      "no-date": null,
    });
    expect(getScheduleOptions(undefined, new Date(2026, 8, 29))[2].title).toBe("Later This Week (Thu 1 Oct)");
  });

  it("respects Todoist's configured next-week and weekend days", () => {
    const result = dates(new Date(2026, 8, 29), { next_week: 7, weekend_start_day: 5, start_day: 1 });
    expect(result.weekend).toBe("2026-10-02");
    expect(result["next-week"]).toBe("2026-10-04");
  });

  it("uses defaults for missing or invalid settings", () => {
    const now = new Date(2026, 8, 29);
    expect(dates(now, { next_week: 0, weekend_start_day: 8, start_day: 1.5 })).toEqual(dates(now));
  });

  it("keeps this weekend on Saturday and labels the following weekend accurately on Sunday", () => {
    const saturday = getScheduleOptions(undefined, new Date(2026, 9, 3));
    const sunday = getScheduleOptions(undefined, new Date(2026, 9, 4));
    expect(saturday.find(({ key }) => key === "weekend")?.title).toBe("This Weekend (Sat 3 Oct)");
    expect(sunday.find(({ key }) => key === "weekend")?.title).toBe("Next Weekend (Sat 10 Oct)");
    expect(saturday.some(({ key }) => key === "later-this-week")).toBe(false);
    expect(sunday.some(({ key }) => key === "later-this-week")).toBe(false);
    expect(dates(new Date(2026, 9, 4))["next-week"]).toBe("2026-10-05");
  });

  it("hides later-this-week when two days ahead falls outside the configured week", () => {
    const friday = new Date(2026, 9, 2);
    expect(dates(friday)["later-this-week"]).toBe("2026-10-04");
    expect(dates(friday, { start_day: 7 })["later-this-week"]).toBeUndefined();
  });

  it("uses the following Monday when next week is selected on Monday", () => {
    expect(dates(new Date(2026, 9, 5))["next-week"]).toBe("2026-10-12");
  });

  it("rolls across a year without shifting the local calendar date", () => {
    expect(dates(new Date(2026, 11, 31, 23, 59))).toMatchObject({
      tomorrow: "2027-01-01",
      weekend: "2027-01-02",
      "next-week": "2027-01-04",
    });
  });

  it.each([new Date(2026, 2, 28, 23, 30), new Date(2026, 9, 24, 23, 30)])(
    "keeps calendar days across a daylight-saving transition (%s)",
    (now) => {
      const tomorrow = getScheduleOptions(undefined, now).find(({ key }) => key === "tomorrow")?.date;
      expect(tomorrow?.getDate()).toBe(now.getDate() + 1);
      expect(tomorrow?.getHours()).toBe(0);
    },
  );
});

describe("moving a task with a schedule shortcut", () => {
  const target = new Date(2026, 9, 5);

  it("gives an undated task an all-day date", () => {
    expect(rescheduleToDayPayload({ due: null } as Task, target)).toEqual({ date: "2026-10-05" });
  });

  it.each([false, true])("keeps a floating task's time (recurring: %s)", (recurring) => {
    const task = {
      due: { date: "2026-09-29T09:15:00", string: "every day at 9:15", is_recurring: recurring },
    } as Task;
    expect(rescheduleToDayPayload(task, target)).toEqual({
      date: "2026-10-05T09:15:00",
      ...(recurring ? { string: "every day at 9:15" } : {}),
    });
    expect(task.due?.date).toBe("2026-09-29T09:15:00");
  });

  it("keeps an all-day recurrence without introducing a time", () => {
    const task = { due: { date: "2026-09-29", string: "every weekday", is_recurring: true } } as Task;
    expect(rescheduleToDayPayload(task, target)).toEqual({ date: "2026-10-05", string: "every weekday" });
  });

  it("keeps local time and UTC representation across daylight saving", () => {
    const original = new Date(2026, 9, 23, 9, 15);
    const task = { due: { date: original.toISOString(), is_recurring: false } } as Task;
    const due = rescheduleToDayPayload(task, new Date(2026, 9, 26));
    expect(due.date).toBe(new Date(2026, 9, 26, 9, 15).toISOString());
  });
});
