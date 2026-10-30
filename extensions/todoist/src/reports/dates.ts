export const REPORT_TIME_ZONE = "Europe/Oslo";
export type ReportMode = "day" | "week";
export type ReportRange = { mode: ReportMode; day: string; start: string; end: string; days: string[] };

const calendar = new Intl.DateTimeFormat("sv-SE", {
  timeZone: REPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const clock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: REPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function osloDate(date: Date): string {
  return calendar.format(date);
}

function calendarDate(day: string): Date {
  const value = new Date(`${day}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(value.getTime()) ||
    value.toISOString().slice(0, 10) !== day
  ) {
    throw new Error("Ugyldig rapportdato.");
  }
  return value;
}

export function shiftDay(day: string, count: number): string {
  const value = calendarDate(day);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

/** Resolve each Oslo midnight independently: DST days are not always 24 hours. */
export function osloMidnight(day: string): number {
  calendarDate(day);
  const target = Date.parse(`${day}T00:00:00Z`);
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(clock.formatToParts(new Date(candidate)).map(({ type, value }) => [type, value]));
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const delta = target - observed;
    candidate += delta;
    if (delta === 0) return candidate;
  }
  throw new Error("Kunne ikke beregne datogrensen i Europe/Oslo.");
}

export function reportRange(day: string, mode: ReportMode): ReportRange {
  const weekday = calendarDate(day).getUTCDay();
  const first = mode === "week" ? shiftDay(day, -((weekday + 6) % 7)) : day;
  const days = Array.from({ length: mode === "week" ? 7 : 1 }, (_, index) => shiftDay(first, index));
  return {
    mode,
    day: first,
    start: new Date(osloMidnight(first)).toISOString(),
    end: new Date(osloMidnight(shiftDay(first, days.length))).toISOString(),
    days,
  };
}

export function shiftRange(range: ReportRange, direction: number): ReportRange {
  return reportRange(shiftDay(range.day, direction * range.days.length), range.mode);
}

export function formatReportDay(day: string): string {
  return new Intl.DateTimeFormat("nb-NO", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(
    calendarDate(day),
  );
}
