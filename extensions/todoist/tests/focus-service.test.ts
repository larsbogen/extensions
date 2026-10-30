import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CachedDataParams, SyncData, Task } from "../src/api";

const mocks = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  environment: { supportPath: "" },
  prefs: { focusLabelName: "focus", showFocusWindow: true, focusDuration: "25" },
  start: vi.fn(),
  stop: vi.fn(),
  sync: vi.fn(),
  update: vi.fn(),
  hud: vi.fn(),
}));
vi.mock("@raycast/api", () => ({
  environment: mocks.environment,
  getPreferenceValues: () => mocks.prefs,
  showHUD: mocks.hud,
  Cache: class {
    get(key: string) {
      return mocks.cache.get(key);
    }
    set(key: string, value: string) {
      mocks.cache.set(key, value);
    }
  },
}));
vi.mock("../src/api", () => ({ initialSync: mocks.sync, updateTask: mocks.update }));
vi.mock("../src/focus/panel", () => ({ showFocusPanel: mocks.start, stopFocusPanel: mocks.stop }));
import { clearFocusedTask, startFocusedTask } from "../src/focus/service";

const task = { id: "b", content: "B", labels: [], project_id: "p" } as unknown as Task;
const old = { id: "a", content: "A", labels: ["focus", "keep"], project_id: "p" } as unknown as Task;
const data = { user: { id: "owner" }, projects: [{ id: "p", name: "P" }], items: [old, task] } as SyncData;
const state: CachedDataParams = { data, setData: vi.fn() };
const guard = { sessionId: "session", requestId: "request" };
const queue = { accountId: "owner", day: "2026-10-30", entryId: "entry", revision: 2 };

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.cache.clear();
  mocks.environment.supportPath = await mkdtemp(join(tmpdir(), "focus-service-test-"));
  await mkdir(join(mocks.environment.supportPath, "focus-panel"));
  await writeFile(
    join(mocks.environment.supportPath, "focus-panel", "state.json"),
    JSON.stringify({
      session: {
        id: guard.sessionId,
        pendingNextRequestId: guard.requestId,
      },
    }),
  );
  mocks.cache.set("todoist.focusedTask", JSON.stringify({ id: "a", content: "A" }));
  mocks.sync.mockResolvedValue(data);
  mocks.hud.mockResolvedValue(undefined);
});
afterEach(async () => {
  await rm(mocks.environment.supportPath, { recursive: true, force: true });
});

describe("shared focus service", () => {
  it("starts a guarded queue transition with account/project metadata without stopping or hiding the paused card", async () => {
    await startFocusedTask(task, state, queue, guard);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ todoistUserId: "owner", projectName: "P", queue }),
      25,
      guard,
    );
    expect(JSON.parse(mocks.cache.get("todoist.focusedTask")!).id).toBe("b");
    expect(mocks.update).toHaveBeenCalledWith({ id: "a", labels: ["keep"] }, state);
  });
  it("retains old focus when the helper rejects a stale transition", async () => {
    mocks.start.mockRejectedValue(new Error("stale"));
    await expect(startFocusedTask(task, state, queue, guard)).rejects.toThrow("stale");
    expect(JSON.parse(mocks.cache.get("todoist.focusedTask")!).id).toBe("a");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("reports label failures after an acknowledged start as a warning rather than a failed queue transition", async () => {
    mocks.update.mockRejectedValue(new Error("offline"));
    await expect(startFocusedTask(task, state, queue, guard)).resolves.toBeUndefined();
    expect(JSON.parse(mocks.cache.get("todoist.focusedTask")!).id).toBe("b");
    expect(mocks.hud).toHaveBeenCalledWith(expect.stringContaining("Fokuset er startet"));
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it("rejects account changes before starting the helper", async () => {
    await expect(startFocusedTask(task, state, { ...queue, accountId: "other" }, guard)).rejects.toThrow(
      "annen Todoist-konto",
    );
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("does not let missing-task menu-bar cleanup hide an in-progress queued completion", async () => {
    const directory = join(mocks.environment.supportPath, "focus-panel");
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({ session: { id: "session", phase: "paused", task: { id: "a", queue } } }),
    );
    await writeFile(join(directory, "complete-session.json"), JSON.stringify({ sessionId: "session", taskId: "a" }));
    expect(await clearFocusedTask(state, { automatic: true })).toBe(false);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.cache.get("todoist.focusedTask")!).id).toBe("a");
    expect(await clearFocusedTask(state)).toBe(true);
    expect(mocks.stop).toHaveBeenCalledWith("a", undefined);
  });

  it("preserves focus if native automatic cleanup detects a completion that started after the local check", async () => {
    mocks.stop.mockResolvedValue(false);
    expect(await clearFocusedTask(state, { automatic: true })).toBe(false);
    expect(JSON.parse(mocks.cache.get("todoist.focusedTask")!).id).toBe("a");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("clears an ordinary focus through the same service and preserves unrelated labels", async () => {
    await clearFocusedTask(state);
    expect(mocks.stop).toHaveBeenCalledWith("a", undefined);
    expect(mocks.update).toHaveBeenCalledWith({ id: "a", labels: ["keep"] }, expect.anything());
    expect(JSON.parse(mocks.cache.get("todoist.focusedTask")!)).toEqual({ id: "", content: "" });
  });
});
