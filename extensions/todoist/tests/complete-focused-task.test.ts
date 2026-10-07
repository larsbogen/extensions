import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environment: { supportPath: "" },
  cache: new Map<string, string>(),
  close: vi.fn(),
  sync: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
  failure: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@raycast/api", () => ({
  environment: mocks.environment,
  Cache: class {
    get(key: string) {
      return mocks.cache.get(key);
    }
    set(key: string, value: string) {
      mocks.cache.set(key, value);
    }
  },
  getPreferenceValues: () => ({ focusLabelName: "focus" }),
  showToast: mocks.toast,
  Toast: { Style: { Failure: "failure", Success: "success" } },
}));
vi.mock("@raycast/utils", () => ({ showFailureToast: mocks.failure }));
vi.mock("../src/api", () => ({ closeTask: mocks.close, initialSync: mocks.sync, updateTask: mocks.update }));
vi.mock("../src/helpers/menu-bar", () => ({ refreshMenuBarCommand: mocks.refresh }));
vi.mock("../src/helpers/withTodoistApi", () => ({ withTodoistApi: (fn: unknown) => fn }));
import { completeFocusedTask } from "../src/complete-focused-task";

const sessionId = "11111111-1111-4111-8111-111111111111";
const props = {
  launchContext: { sessionId, taskId: "task-a" },
  arguments: {},
  launchType: "userInitiated",
} as Parameters<typeof completeFocusedTask>[0];
let directory: string;
async function session(id = sessionId, taskId = "task-a") {
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({ session: { id, task: { id: taskId }, phase: "paused" } }),
  );
}
async function result() {
  return JSON.parse(await readFile(join(directory, "completion.json"), "utf8"));
}
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.cache.clear();
  mocks.environment.supportPath = await mkdtemp(join(tmpdir(), "todoist-complete-test-"));
  directory = join(mocks.environment.supportPath, "focus-panel");
  await mkdir(directory);
  await session();
  mocks.cache.set("todoist.focusedTask", JSON.stringify({ id: "task-a", content: "A" }));
  mocks.sync.mockResolvedValue({ items: [{ id: "task-a", labels: ["focus", "keep"] }] });
});
afterEach(async () => {
  await rm(mocks.environment.supportPath, { recursive: true, force: true });
});

describe("complete from focus card", () => {
  it("completes using a stable ID, clears focus, removes a recurring task's focus label, and acknowledges success", async () => {
    await completeFocusedTask(props);
    expect(mocks.close).toHaveBeenCalledWith("task-a", expect.any(Object), sessionId);
    expect(JSON.parse(mocks.cache.get("todoist.focusedTask")!)).toEqual({ id: "", content: "" });
    expect(mocks.update).toHaveBeenCalledWith({ id: "task-a", labels: ["keep"] }, expect.any(Object));
    expect(await result()).toEqual({ sessionId, success: true });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("completes Todoist while warning that a durable Toggl stop is pending", async () => {
    const file = join(directory, "state.json");
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    snapshot.tracking = { periods: [{ sessionID: sessionId, sync: "updating" }] };
    await writeFile(file, JSON.stringify(snapshot));
    await completeFocusedTask(props);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(await result()).toEqual({ sessionId, success: true });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Toggl venter") }),
    );
  });

  it("preserves focus after an API failure and retries with the same completion ID", async () => {
    mocks.close.mockRejectedValueOnce(new Error("offline"));
    await completeFocusedTask(props);
    expect((await result()).success).toBe(false);
    expect(JSON.parse(mocks.cache.get("todoist.focusedTask")!).id).toBe("task-a");
    expect(mocks.update).not.toHaveBeenCalled();
    await completeFocusedTask(props);
    expect(mocks.close.mock.calls.map((call) => call[2])).toEqual([sessionId, sessionId]);
    expect((await result()).success).toBe(true);
  });
  it("ignores an old card and preserves a new focus selected during completion", async () => {
    await session("22222222-2222-4222-8222-222222222222", "task-b");
    await completeFocusedTask(props);
    expect(mocks.close).not.toHaveBeenCalled();
    await session();
    mocks.close.mockImplementationOnce(async () => {
      await session("22222222-2222-4222-8222-222222222222", "task-b");
      mocks.cache.set("todoist.focusedTask", JSON.stringify({ id: "task-b", content: "B" }));
    });
    await completeFocusedTask(props);
    expect(JSON.parse(mocks.cache.get("todoist.focusedTask")!).id).toBe("task-b");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("still stops focus if cleaning up the label fails after completion", async () => {
    mocks.update.mockRejectedValueOnce(new Error("offline"));
    await completeFocusedTask(props);
    expect((await result()).success).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("fokusetiketten") }),
    );
  });
  it("suppresses overlapping clicks", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.close.mockImplementationOnce(async () => {
      started();
      await wait;
    });
    const first = completeFocusedTask(props);
    await running;
    await completeFocusedTask(props);
    expect(mocks.close).toHaveBeenCalledOnce();
    release();
    await first;
  });
});
