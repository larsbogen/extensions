import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  fetchCompletions,
  withCachedCompletions,
  type ActivityLimits,
  type CompletionReport,
  type ReportClient,
} from "./activity";
import { aggregateFocus, readFocusHistory, type FocusReport, type ReportProject } from "./model";
import type { ReportRange } from "./dates";

type ReportContext = {
  version: 1;
  account: { id: string; name: string };
  projects: ReportProject[];
  limits?: ActivityLimits;
  confirmedAt: string;
};
export type WorkReport = {
  account: ReportContext["account"];
  projects: ReportProject[];
  range: ReportRange;
  focus: FocusReport;
  localAvailable: boolean;
  completions: CompletionReport;
  fetchedAt: string;
  issues: string[];
  offline: boolean;
};

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicJson(directory: string, name: string, value: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

function validContext(value: unknown): value is ReportContext {
  const context = value as ReportContext | undefined;
  return (
    !!context &&
    context.version === 1 &&
    typeof context.account?.id === "string" &&
    typeof context.account.name === "string" &&
    Array.isArray(context.projects) &&
    context.projects.every((p) => typeof p.id === "string" && typeof p.name === "string") &&
    typeof context.confirmedAt === "string" &&
    Number.isFinite(Date.parse(context.confirmedAt))
  );
}

function validCached(value: unknown): value is CompletionReport {
  const report = value as CompletionReport | undefined;
  return (
    !!report &&
    typeof report.accountId === "string" &&
    typeof report.range?.start === "string" &&
    typeof report.range.end === "string" &&
    ["complete", "partial", "unavailable"].includes(report.coverage) &&
    typeof report.fetchedAt === "string" &&
    Array.isArray(report.events) &&
    report.events.every(
      (event) =>
        typeof event.id === "string" &&
        typeof event.taskId === "string" &&
        typeof event.title === "string" &&
        typeof event.projectId === "string" &&
        typeof event.at === "string" &&
        Number.isFinite(Date.parse(event.at)),
    )
  );
}

export class WorkReportService {
  constructor(
    private directory: string,
    private focusStatePath: string,
    private client: ReportClient,
    private now = () => new Date(),
  ) {}

  async load(range: ReportRange): Promise<WorkReport> {
    const now = this.now();
    const issues: string[] = [];
    let context: ReportContext;
    let offline = false;
    try {
      // This read has its own snapshot and does not change the extension's sync
      // token or regular task cache. Only public account metadata is persisted.
      const { data } = await this.client.post(
        "/sync",
        { sync_token: "*", resource_types: ["user", "projects", "user_plan_limits"] },
        { timeout: 15000 },
      );
      const response = data as {
        user?: { id?: string; full_name?: string };
        projects?: ReportProject[];
        user_plan_limits?: { current?: ActivityLimits };
      };
      if (!response?.user?.id || !Array.isArray(response.projects)) throw new Error("Missing report context");
      context = {
        version: 1,
        account: { id: response.user.id, name: response.user.full_name || "Todoist-konto" },
        projects: response.projects.map(({ id, name }) => ({ id, name })),
        limits: response.user_plan_limits?.current,
        confirmedAt: now.toISOString(),
      };
      if (!validContext(context)) throw new Error("Invalid report context");
      await atomicJson(this.directory, "context.json", context).catch(() =>
        issues.push("Kontometadata kunne ikke lagres lokalt."),
      );
    } catch {
      const cachedContext = await readJson(join(this.directory, "context.json")).catch(() => undefined);
      if (!validContext(cachedContext))
        throw new Error("Kunne ikke hente Todoist-kontoen. Oppdater for å prøve igjen.");
      context = cachedContext;
      offline = true;
      issues.push("Frakoblet: viser sist bekreftede konto. Gjeldende konto og Todoist-data kunne ikke bekreftes.");
    }
    const key = createHash("sha256").update(`${context.account.id}\n${range.start}\n${range.end}`).digest("hex");
    const cachedValue = await readJson(join(this.directory, `${key}.json`)).catch(() => undefined);
    const cached = validCached(cachedValue) ? cachedValue : undefined;
    const fetched: CompletionReport = offline
      ? {
          accountId: context.account.id,
          range,
          events: [],
          fetchedAt: now.toISOString(),
          coverage: "unavailable",
          issues: ["Todoist-historikken kunne ikke oppdateres."],
        }
      : await fetchCompletions(this.client, context.account.id, range, context.limits, now);
    const completions = withCachedCompletions(fetched, cached);
    if (!offline)
      await atomicJson(this.directory, `${key}.json`, completions).catch(() =>
        issues.push("Fullføringshistorikken kunne ikke lagres lokalt."),
      );

    let localAvailable = true;
    let focus: FocusReport = { slices: [], legacySlices: [], issues: [] };
    try {
      const state = await readJson(this.focusStatePath);
      if (state !== undefined)
        focus = aggregateFocus(readFocusHistory(state), context.account.id, range, context.projects);
    } catch {
      localAvailable = false;
      focus.issues.push("Lokal fokushistorikk kunne ikke leses. Arbeidstid er ikke tilgjengelig.");
    }
    return {
      account: context.account,
      projects: context.projects,
      range,
      focus,
      localAvailable,
      completions,
      fetchedAt: now.toISOString(),
      issues,
      offline,
    };
  }
}
