import { osloMidnight, shiftDay, type ReportRange } from "./dates";

export type TimeStatus = "confirmed" | "pending" | "local" | "deviation";
export const TIME_STATUS_LABELS: Record<TimeStatus, string> = {
  confirmed: "Bekreftet i Toggl",
  pending: "Venter på Toggl",
  local: "Bare lokalt",
  deviation: "Avvik / krever gjennomgang",
};
export type ReportProject = { id: string; name: string };
export type FocusPeriod = {
  id: string;
  sessionID?: string;
  start: number;
  checkpoint: number;
  stop?: number | null;
  activeDuration: number;
  sync: string;
  recoveryDetectedAt?: number | null;
  task: { id: string; title?: string; projectId?: string; projectName?: string; todoistUserId?: string };
};
export type TimeSlice = {
  periodId: string;
  taskId: string;
  title: string;
  day: string;
  projectId: string;
  projectName: string;
  seconds: number;
  status: TimeStatus;
};
export type FocusHistory = {
  version?: number;
  updatedAt?: number;
  periods: FocusPeriod[];
  undated: boolean;
  issues: string[];
};
export type TimeTotals = { seconds: number; status: Record<TimeStatus, number> };
export type FocusReport = { slices: TimeSlice[]; legacySlices: TimeSlice[]; issues: string[]; updatedAt?: string };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function readFocusHistory(value: unknown): FocusHistory {
  const state = value as {
    version?: number;
    updatedAt?: number;
    tracking?: { periods?: unknown[] };
    session?: { id?: string; elapsed?: number };
    undatedLegacySeconds?: number;
  } | null;
  if (
    !state ||
    ![1, 2, 3].includes(state.version ?? 0) ||
    (state.tracking?.periods !== undefined && !Array.isArray(state.tracking.periods))
  ) {
    throw new Error("Fokushistorikken har et ukjent format.");
  }
  const periods: FocusPeriod[] = [];
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const raw of state.tracking?.periods ?? []) {
    const period = raw as FocusPeriod | null;
    if (
      !period ||
      typeof period.id !== "string" ||
      !period.id ||
      !finite(period.start) ||
      !finite(period.checkpoint) ||
      !finite(period.activeDuration) ||
      period.activeDuration < 0 ||
      period.checkpoint < period.start ||
      (period.stop != null && (!finite(period.stop) || period.stop < period.start)) ||
      !period.task ||
      typeof period.task.id !== "string" ||
      typeof period.sync !== "string"
    ) {
      issues.push("En ugyldig arbeidsperiode kunne ikke tas med.");
      continue;
    }
    if (!ids.has(period.id)) {
      periods.push(period);
      ids.add(period.id);
    }
  }
  const datedSessionSeconds = periods
    .filter((period) => period.sessionID === state.session?.id)
    .reduce((sum, period) => sum + period.activeDuration, 0);
  const inferredLegacy =
    state.version === 1 || state.session?.id ? Math.max(0, (state.session?.elapsed ?? 0) - datedSessionSeconds) : 0;
  const undatedSeconds = Math.max(finite(state.undatedLegacySeconds) ? state.undatedLegacySeconds : 0, inferredLegacy);
  const undated = undatedSeconds > 0;
  if (undated)
    issues.push(`Eldre økttid (${durationLabel(undatedSeconds)}) mangler sikre datoer og er ikke fordelt på dager.`);
  return {
    version: state.version,
    updatedAt: finite(state.updatedAt) ? state.updatedAt : undefined,
    periods,
    undated,
    issues: [...new Set(issues)],
  };
}

export function periodStatus(period: FocusPeriod): TimeStatus {
  if (period.recoveryDetectedAt != null || ["accepted", "review", "uncertain"].includes(period.sync))
    return "deviation";
  if (period.sync === "local") return "local";
  // An externally running timer is not a confirmed final duration.
  if (period.sync === "synced" && period.stop != null) return "confirmed";
  if (["pending", "creating", "running", "updating"].includes(period.sync)) return "pending";
  return "deviation";
}

export function aggregateFocus(
  history: FocusHistory,
  accountId: string,
  range: ReportRange,
  projects: ReportProject[],
): FocusReport {
  const slices: TimeSlice[] = [],
    legacySlices: TimeSlice[] = [];
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const boundaries = range.days.map((day) => ({
    day,
    start: osloMidnight(day) / 1000,
    end: osloMidnight(shiftDay(day, 1)) / 1000,
  }));
  const first = Date.parse(range.start) / 1000,
    last = Date.parse(range.end) / 1000;
  for (const period of history.periods) {
    const owner = period.task.todoistUserId;
    if (owner && owner !== accountId) continue;
    // The coordinator records checkpoint = start + activeDuration. Never infer work
    // after the persisted checkpoint, even if a process crashed with an open period.
    const stop = Math.min(period.start + period.activeDuration, period.checkpoint, period.stop ?? Infinity);
    if (!Number.isFinite(stop) || stop <= period.start || stop <= first || period.start >= last) continue;
    for (const boundary of boundaries) {
      const start = Math.max(period.start, boundary.start);
      const end = Math.min(stop, boundary.end);
      if (end <= start) continue;
      const projectId = period.task.projectId ?? "unknown";
      (owner ? slices : legacySlices).push({
        periodId: period.id,
        taskId: period.task.id,
        title: period.task.title ?? "Uten tittel",
        day: boundary.day,
        projectId,
        projectName: period.task.projectName || projectNames.get(projectId) || "Ukjent prosjekt",
        seconds: end - start,
        status: periodStatus(period),
      });
    }
  }
  return {
    slices,
    legacySlices,
    issues: history.issues,
    updatedAt: history.updatedAt === undefined ? undefined : new Date(history.updatedAt * 1000).toISOString(),
  };
}

export function timeTotals(slices: TimeSlice[]): TimeTotals {
  return slices.reduce<TimeTotals>(
    (total, slice) => {
      total.seconds += slice.seconds;
      total.status[slice.status] += slice.seconds;
      return total;
    },
    { seconds: 0, status: { confirmed: 0, pending: 0, local: 0, deviation: 0 } },
  );
}

export function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (seconds > 0 && minutes === 0) return "under 1 min";
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} t ${minutes % 60} min`;
}
