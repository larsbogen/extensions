import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activityCoverage,
  fetchCompletions,
  withCachedCompletions,
  type CompletionReport,
  type ReportClient,
} from "../src/reports/activity";
import { reportRange } from "../src/reports/dates";
import { WorkReportService } from "../src/reports/service";

const range = reportRange("2026-10-29", "day");
const now = new Date("2026-10-29T12:00:00Z");
const unlimited = { activity_log: true, activity_log_limit: -1 };
const event = (id: string | number, extra: Record<string, unknown> = {}) => ({
  id,
  object_id: "recurring-task",
  object_type: "item",
  event_type: "completed",
  event_date: "2026-10-29T10:00:00Z",
  initiator_id: "me",
  parent_project_id: "project",
  extra_data: { content: "Oppgave" },
  ...extra,
});
const client = () => ({ get: vi.fn<ReportClient["get"]>(), post: vi.fn<ReportClient["post"]>() });

describe("completion event retrieval", () => {
  it("paginates with a fixed account/date filter and counts recurring completions separately", async () => {
    const api = client();
    api.get
      .mockResolvedValueOnce({ data: { results: [event(1)], next_cursor: "second" } })
      .mockResolvedValueOnce({ data: { results: [event(1), event(2)], next_cursor: null } });
    const report = await fetchCompletions(api, "me", range, unlimited, now);
    expect(report.coverage).toBe("complete");
    expect(report.events).toHaveLength(2);
    expect(report.events.map((e) => e.taskId)).toEqual(["recurring-task", "recurring-task"]);
    expect(api.get).toHaveBeenNthCalledWith(2, "/activities", {
      timeout: 15000,
      params: {
        object_event_types: '["item:completed"]',
        initiator_id: "me",
        date_from: range.start,
        date_to: range.end,
        limit: 200,
        cursor: "second",
      },
    });
  });
  it("excludes explicit collaborators and outside dates while accepting server-filtered null initiators", async () => {
    const api = client();
    api.get.mockResolvedValue({
      data: {
        results: [
          event(1, { initiator_id: "other" }),
          event(2, { initiator_id: null }),
          event(3, { event_date: range.end }),
          event(4, { event_date: range.start }),
          event(5, { event_type: "uncompleted" }),
        ],
        next_cursor: null,
      },
    });
    expect((await fetchCompletions(api, "me", range, unlimited, now)).events.map((e) => e.id).sort()).toEqual([
      "2",
      "4",
    ]);
  });
  it("distinguishes an empty complete result from network failure", async () => {
    const api = client();
    api.get
      .mockResolvedValueOnce({ data: { results: [], next_cursor: null } })
      .mockRejectedValueOnce(new Error("offline"));
    expect((await fetchCompletions(api, "me", range, unlimited, now)).coverage).toBe("complete");
    const unavailable = await fetchCompletions(api, "me", range, unlimited, now);
    expect(unavailable.coverage).toBe("unavailable");
    expect(unavailable.issues).not.toEqual([]);
  });
  it("retains partial events on page-two failure and does not leak raw network errors", async () => {
    const api = client();
    api.get
      .mockResolvedValueOnce({ data: { results: [event(1)], next_cursor: "next" } })
      .mockRejectedValueOnce(new Error("token=SECRET"));
    const report = await fetchCompletions(api, "me", range, unlimited, now);
    expect(report.coverage).toBe("partial");
    expect(report.events).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });
  it("stops repeated pagination cursors instead of hanging", async () => {
    const api = client();
    api.get.mockResolvedValue({ data: { results: [event(1)], next_cursor: "same" } });
    expect((await fetchCompletions(api, "me", range, unlimited, now)).coverage).toBe("partial");
    expect(api.get).toHaveBeenCalledTimes(2);
  });
  it("makes missing and expired history explicit and respects disabled access", async () => {
    expect(activityCoverage(undefined, range, now).coverage).toBe("partial");
    expect(
      activityCoverage({ activity_log: true, activity_log_limit: 7 }, reportRange("2026-10-01", "day"), now).coverage,
    ).toBe("partial");
    const api = client();
    expect((await fetchCompletions(api, "me", range, { activity_log: false }, now)).coverage).toBe("unavailable");
    expect(api.get).not.toHaveBeenCalled();
  });
  it("does not mark invalid records as complete coverage", async () => {
    const api = client();
    api.get.mockResolvedValue({ data: { results: [{ id: "bad" }, event(1)], next_cursor: null } });
    const report = await fetchCompletions(api, "me", range, unlimited, now);
    expect(report.coverage).toBe("partial");
    expect(report.events).toHaveLength(1);
  });
  it("never merges cached completions across account or period boundaries", () => {
    const current: CompletionReport = {
      accountId: "me",
      range,
      coverage: "partial",
      events: [],
      fetchedAt: now.toISOString(),
      issues: [],
    };
    expect(
      withCachedCompletions(current, {
        ...current,
        accountId: "other",
        events: [{ id: "private", taskId: "t", at: now.toISOString(), title: "Private", projectId: "p" }],
      }),
    ).toEqual(current);
    expect(withCachedCompletions(current, { ...current, range: reportRange("2026-10-28", "day") })).toEqual(current);
  });
});

describe("report service cache and offline data", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "todoist-reports-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function setup() {
    const api = client();
    api.post.mockResolvedValue({
      data: {
        user: { id: "me", full_name: "Test" },
        projects: [{ id: "project", name: "Arbeid" }],
        user_plan_limits: { current: unlimited },
      },
    });
    api.get.mockResolvedValue({ data: { results: [event(1)], next_cursor: null } });
    return {
      api,
      service: new WorkReportService(join(directory, "reports"), join(directory, "state.json"), api, () => now),
    };
  }
  it("reads local time without starting a helper and falls back to an explicitly stale account/cache", async () => {
    const { api, service } = setup();
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({
        version: 2,
        tracking: {
          periods: [
            {
              id: "p",
              start: Date.parse("2026-10-29T09:00:00Z") / 1000,
              checkpoint: Date.parse("2026-10-29T09:10:00Z") / 1000,
              activeDuration: 600,
              sync: "local",
              task: { id: "t", todoistUserId: "me" },
            },
          ],
        },
      }),
    );
    expect((await service.load(range)).completions.coverage).toBe("complete");
    api.post.mockRejectedValue(new Error("offline"));
    const report = await service.load(range);
    expect(report.offline).toBe(true);
    expect(report.focus.slices[0].seconds).toBe(600);
    expect(report.completions.events).toHaveLength(1);
    expect(report.completions.coverage).toBe("partial");
    expect(report.completions.cachedAt).toBe(now.toISOString());
    expect(api.get).toHaveBeenCalledTimes(1);
    expect((await readdir(join(directory, "reports"))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
  it("keeps new account reports separate and does not import previous account events", async () => {
    const { api, service } = setup();
    await service.load(range);
    api.post.mockResolvedValue({
      data: { user: { id: "other", full_name: "Other" }, projects: [], user_plan_limits: { current: unlimited } },
    });
    api.get.mockRejectedValue(new Error("offline"));
    const report = await service.load(range);
    expect(report.account.id).toBe("other");
    expect(report.completions.events).toEqual([]);
    expect(report.completions.coverage).toBe("unavailable");
  });
  it("reports unreadable local history separately while still showing Todoist completions", async () => {
    const { service } = setup();
    await writeFile(join(directory, "state.json"), "broken json");
    const report = await service.load(range);
    expect(report.localAvailable).toBe(false);
    expect(report.focus.issues).toHaveLength(1);
    expect(report.completions.events).toHaveLength(1);
  });
  it("never persists credentials or unrelated sync fields", async () => {
    const { api, service } = setup();
    api.post.mockResolvedValue({
      data: {
        user: { id: "me", full_name: "Test", token: "SECRET" },
        projects: [],
        user_plan_limits: { current: unlimited },
        sync_token: "PRIVATE",
      },
    });
    await service.load(range);
    const metadata = await readFile(join(directory, "reports", "context.json"), "utf8");
    expect(metadata).not.toContain("SECRET");
    expect(metadata).not.toContain("PRIVATE");
  });
});
