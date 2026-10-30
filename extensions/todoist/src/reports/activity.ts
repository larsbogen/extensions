import type { ReportRange } from "./dates";

export type ReportClient = {
  get(url: string, config: { params: Record<string, unknown>; timeout: number }): Promise<{ data: unknown }>;
  post(url: string, data: Record<string, unknown>, config: { timeout: number }): Promise<{ data: unknown }>;
};
export type ActivityLimits = { activity_log?: boolean; activity_log_limit?: number };
export type CompletionEvent = { id: string; taskId: string; at: string; title: string; projectId: string };
export type CompletionReport = {
  accountId: string;
  range: ReportRange;
  events: CompletionEvent[];
  fetchedAt: string;
  coverage: "complete" | "partial" | "unavailable";
  issues: string[];
  cachedAt?: string;
};

export function activityCoverage(
  limits: ActivityLimits | undefined,
  range: ReportRange,
  now: Date,
): { coverage: CompletionReport["coverage"]; issues: string[] } {
  if (limits?.activity_log === false)
    return { coverage: "unavailable", issues: ["Todoist-abonnementet gir ikke tilgang til aktivitetshistorikken."] };
  if (
    limits?.activity_log !== true ||
    !Number.isInteger(limits.activity_log_limit) ||
    (limits.activity_log_limit ?? -2) < -1
  ) {
    return { coverage: "partial", issues: ["Todoists grense for aktivitetshistorikk kunne ikke bekreftes."] };
  }
  if (
    limits.activity_log_limit !== -1 &&
    Date.parse(range.start) < now.getTime() - limits.activity_log_limit! * 86400000
  ) {
    return {
      coverage: "partial",
      issues: ["Deler av perioden er eldre enn Todoist-abonnementets aktivitetshistorikk."],
    };
  }
  return { coverage: "complete", issues: [] };
}

export async function fetchCompletions(
  client: ReportClient,
  accountId: string,
  range: ReportRange,
  limits: ActivityLimits | undefined,
  now = new Date(),
): Promise<CompletionReport> {
  const coverage = activityCoverage(limits, range, now);
  const result: CompletionReport = { accountId, range, events: [], fetchedAt: now.toISOString(), ...coverage };
  if (result.coverage === "unavailable") return result;
  const events = new Map<string, CompletionEvent>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const { data } = await client.get("/activities", {
        params: {
          object_event_types: JSON.stringify(["item:completed"]),
          initiator_id: accountId,
          date_from: range.start,
          date_to: range.end,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        },
        timeout: 15000,
      });
      const page = data as { results?: unknown[]; next_cursor?: string | null };
      if (!page || !Array.isArray(page.results) || (page.next_cursor != null && typeof page.next_cursor !== "string"))
        throw new Error("Invalid activity page");
      for (const raw of page.results) {
        const event = raw as {
          id?: string | number;
          object_id?: string | number;
          event_date?: string;
          event_type?: string;
          object_type?: string;
          initiator_id?: string | number | null;
          parent_project_id?: string | number;
          extra_data?: { content?: string };
        } | null;
        if (
          !event ||
          !["string", "number"].includes(typeof event.id) ||
          !["string", "number"].includes(typeof event.object_id) ||
          !event.event_date ||
          !Number.isFinite(Date.parse(event.event_date))
        ) {
          result.coverage = "partial";
          result.issues.push("En fullføringshendelse hadde ufullstendige data.");
          continue;
        }
        if (
          (event.event_type && event.event_type !== "completed") ||
          (event.object_type && !["item", "task"].includes(event.object_type))
        )
          continue;
        // Null initiators can represent the current user; the server-side filter
        // remains authoritative. Explicit other collaborators must never count.
        if (event.initiator_id != null && String(event.initiator_id) !== accountId) continue;
        const at = new Date(event.event_date).toISOString();
        if (at < range.start || at >= range.end) continue;
        events.set(String(event.id), {
          id: String(event.id),
          taskId: String(event.object_id),
          at,
          title: event.extra_data?.content?.trim() || "Uten tittel",
          projectId: event.parent_project_id == null ? "unknown" : String(event.parent_project_id),
        });
      }
      cursor = page.next_cursor || undefined;
      if (cursor) {
        if (cursors.has(cursor) || cursors.size >= 1000) throw new Error("Incomplete pagination");
        cursors.add(cursor);
      }
    } while (cursor);
  } catch {
    result.coverage = events.size ? "partial" : "unavailable";
    result.issues.push("Kunne ikke hente hele aktivitetshistorikken. Oppdater for å prøve igjen.");
  }
  result.events = [...events.values()].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  result.issues = [...new Set(result.issues)];
  return result;
}

export function withCachedCompletions(current: CompletionReport, cached?: CompletionReport): CompletionReport {
  if (
    !cached ||
    current.coverage === "complete" ||
    cached.accountId !== current.accountId ||
    cached.range.start !== current.range.start ||
    cached.range.end !== current.range.end
  )
    return current;
  const events = new Map(cached.events.map((event) => [event.id, event]));
  current.events.forEach((event) => events.set(event.id, event));
  return {
    ...current,
    events: [...events.values()].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)),
    coverage: events.size ? "partial" : current.coverage,
    cachedAt: cached.cachedAt ?? cached.fetchedAt,
    issues: [...current.issues, "Viser også tidligere lagrede fullføringer; oppdatert dekning er ikke bekreftet."],
  };
}
