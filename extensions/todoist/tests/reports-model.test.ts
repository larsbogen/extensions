import { describe, expect, it } from "vitest";
import { osloDate, osloMidnight, reportRange, shiftRange } from "../src/reports/dates";
import {
  aggregateFocus,
  durationLabel,
  periodStatus,
  readFocusHistory,
  timeTotals,
  type FocusPeriod,
} from "../src/reports/model";

const seconds = (iso: string) => Date.parse(iso) / 1000;
function period(overrides: Partial<FocusPeriod> = {}): FocusPeriod {
  return {
    id: "one",
    start: seconds("2026-10-29T09:00:00Z"),
    checkpoint: seconds("2026-10-29T09:20:00Z"),
    stop: seconds("2026-10-29T09:20:00Z"),
    activeDuration: 1200,
    sync: "local",
    task: { id: "task", title: "Oppgave", projectId: "todoist-project", projectName: "Arbeid", todoistUserId: "me" },
    ...overrides,
  };
}
const history = (periods: FocusPeriod[]) =>
  readFocusHistory({ version: 2, updatedAt: seconds("2026-10-29T10:00:00Z"), tracking: { periods } });

describe("report calendar boundaries", () => {
  it("uses Oslo dates instead of the host zone", () => {
    expect(osloDate(new Date("2026-10-29T23:30:00Z"))).toBe("2026-10-30");
    expect(reportRange("2026-10-30", "day")).toMatchObject({
      start: "2026-10-29T23:00:00.000Z",
      end: "2026-10-30T23:00:00.000Z",
    });
  });
  it("starts weeks on Monday, including year boundaries", () => {
    const range = reportRange("2027-01-01", "week");
    expect(range.day).toBe("2026-12-28");
    expect(range.days).toHaveLength(7);
    expect(shiftRange(range, 1).day).toBe("2027-01-04");
    expect(shiftRange(range, -1).day).toBe("2026-12-21");
  });
  it("handles both 23-hour and 25-hour days", () => {
    const spring = reportRange("2026-03-29", "day"),
      autumn = reportRange("2026-10-25", "day");
    expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(23 * 3600000);
    expect(Date.parse(autumn.end) - Date.parse(autumn.start)).toBe(25 * 3600000);
  });
  it("rejects impossible calendar dates", () => {
    expect(() => osloMidnight("2026-02-30")).toThrow();
    expect(() => reportRange("not-a-date", "day")).toThrow();
  });
});

describe("local focus accounting", () => {
  it("sums work periods once and excludes pauses and foreign accounts", () => {
    const periods = [
      period(),
      period({
        id: "two",
        start: seconds("2026-10-29T09:30:00Z"),
        checkpoint: seconds("2026-10-29T09:40:00Z"),
        stop: seconds("2026-10-29T09:40:00Z"),
        activeDuration: 600,
      }),
      period({ id: "foreign", task: { id: "foreign", todoistUserId: "other" } }),
    ];
    const report = aggregateFocus(history(periods), "me", reportRange("2026-10-29", "day"), []);
    expect(timeTotals(report.slices).seconds).toBe(1800);
    expect(report.slices).toHaveLength(2);
  });
  it("uses the saved checkpoint of an open/crashed session, never wall time or session elapsed", () => {
    const raw = {
      version: 2,
      session: { elapsed: 9000 },
      tracking: {
        periods: [
          period({
            stop: undefined,
            checkpoint: seconds("2026-10-29T09:10:00Z"),
            activeDuration: 1200,
            sync: "running",
          }),
        ],
      },
    };
    const report = aggregateFocus(readFocusHistory(raw), "me", reportRange("2026-10-29", "day"), []);
    expect(timeTotals(report.slices)).toMatchObject({ seconds: 600, status: { pending: 600 } });
  });
  it("splits periods at Oslo midnight and clips the selected week", () => {
    const p = period({
      start: seconds("2026-10-25T22:50:00Z"),
      checkpoint: seconds("2026-10-25T23:20:00Z"),
      stop: seconds("2026-10-25T23:20:00Z"),
      activeDuration: 1800,
    });
    const sunday = aggregateFocus(history([p]), "me", reportRange("2026-10-25", "day"), []);
    const monday = aggregateFocus(history([p]), "me", reportRange("2026-10-26", "week"), []);
    expect(timeTotals(sunday.slices).seconds).toBe(600);
    expect(timeTotals(monday.slices).seconds).toBe(1200);
    expect(monday.slices[0].day).toBe("2026-10-26");
  });
  it("does not add a phantom hour at autumn DST", () => {
    const p = period({
      start: seconds("2026-10-25T00:30:00Z"),
      checkpoint: seconds("2026-10-25T02:30:00Z"),
      stop: seconds("2026-10-25T02:30:00Z"),
      activeDuration: 7200,
    });
    const report = aggregateFocus(history([p]), "me", reportRange("2026-10-25", "day"), []);
    expect(timeTotals(report.slices).seconds).toBe(7200);
  });
  it("keeps unassociated older periods outside account totals and preserves old project names", () => {
    const legacy = period({ id: "old", task: { id: "t", projectId: "todoist-project" } });
    const report = aggregateFocus(history([period(), legacy]), "me", reportRange("2026-10-29", "day"), [
      { id: "todoist-project", name: "Nytt navn" },
    ]);
    expect(timeTotals(report.slices).seconds).toBe(1200);
    expect(report.slices[0].projectName).toBe("Arbeid");
    expect(report.legacySlices[0].projectName).toBe("Nytt navn");
    expect(timeTotals(report.legacySlices).seconds).toBe(1200);
  });
  it("treats accepted external time and crash recovery as deviations", () => {
    expect(periodStatus(period({ sync: "synced" }))).toBe("confirmed");
    expect(periodStatus(period({ sync: "accepted" }))).toBe("deviation");
    expect(periodStatus(period({ sync: "synced", recoveryDetectedAt: 5 }))).toBe("deviation");
    expect(periodStatus(period({ sync: "running", stop: undefined }))).toBe("pending");
  });
  it("reports legacy undated time and malformed periods without inventing dates", () => {
    const old = readFocusHistory({ version: 1, session: { elapsed: 300 } });
    expect(old.undated).toBe(true);
    expect(old.periods).toEqual([]);
    expect(readFocusHistory({ version: 3, undatedLegacySeconds: 300, tracking: { periods: [] } }).undated).toBe(true);
    expect(
      readFocusHistory({ version: 2, session: { id: "legacy", elapsed: 60 }, tracking: { periods: [] } }).undated,
    ).toBe(true);
    expect(history([period({ checkpoint: NaN })]).issues).toHaveLength(1);
    expect(() => readFocusHistory({ version: 99 })).toThrow();
  });
  it("deduplicates persisted periods and rounds only the display", () => {
    const p = period({ activeDuration: 59.9 });
    expect(
      timeTotals(aggregateFocus(history([p, p]), "me", reportRange("2026-10-29", "day"), []).slices).seconds,
    ).toBeCloseTo(59.9);
    expect(durationLabel(59.9)).toBe("under 1 min");
    expect(durationLabel(3660)).toBe("1 t 1 min");
  });
});
