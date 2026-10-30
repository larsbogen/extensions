import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SyncData, Task } from "../src/api";
import { addTaskToPlan, markCompleted, moveEntry, removeEntry } from "../src/workday/model";
import { WorkdayStore } from "../src/workday/store";

const mocks = vi.hoisted(() => ({
  environment: { supportPath: "" },
  sync: vi.fn(),
  start: vi.fn(),
  assert: vi.fn(),
  hud: vi.fn(),
}));
vi.mock("@raycast/api", () => ({
  environment: mocks.environment,
  Cache: class {
    set() {}
  },
  showHUD: mocks.hud,
}));
vi.mock("../src/api", () => ({ initialSync: mocks.sync }));
vi.mock("../src/focus/service", () => ({ startFocusedTask: mocks.start, assertFocusTransition: mocks.assert }));
vi.mock("../src/helpers/withTodoistApi", () => ({ withTodoistApi: (fn: unknown) => fn }));
import { nextFocusTask } from "../src/next-focus-task";

const sessionId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const accountId = "owner";
const day = "2026-10-30";
const projects = [{ id: "p", name: "Prosjekt" }] as Project[];
const task = (id: string) => ({ id, content: id, project_id: "p", labels: [] }) as unknown as Task;
let store: WorkdayStore;
let directory: string;
let entryId: string;
const props = { arguments: {}, launchType: "userInitiated", launchContext: { sessionId, requestId } } as Parameters<
  typeof nextFocusTask
>[0];

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.environment.supportPath = await mkdtemp(join(tmpdir(), "todoist-next-test-"));
  directory = join(mocks.environment.supportPath, "focus-panel");
  await mkdir(directory);
  store = new WorkdayStore(join(mocks.environment.supportPath, "workdays"));
  const plan = await store.update(accountId, day, (plan) =>
    [task("a"), task("b"), task("c")].reduce((value, task) => addTaskToPlan(value, task, projects), plan),
  );
  entryId = plan.entries[0].id;
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      session: {
        id: sessionId,
        task: { id: "a", queue: { accountId, day, entryId, revision: plan.revision } },
        pendingNextRequestId: requestId,
        phase: "paused",
      },
    }),
  );
  mocks.sync.mockResolvedValue({
    user: { id: accountId },
    projects,
    items: [task("a"), task("b"), task("c")],
  } as SyncData);
  mocks.assert.mockImplementation(async (guard) => {
    const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    if (guard.sessionId !== saved.session.id || guard.requestId !== saved.session.pendingNextRequestId)
      throw new Error("stale request");
  });
});
afterEach(async () => {
  await rm(mocks.environment.supportPath, { recursive: true, force: true });
});

async function result() {
  return JSON.parse(await readFile(join(directory, "next.json"), "utf8"));
}

describe("next workday focus", () => {
  it("starts the next entry with a native session/request guard without completing the skipped task", async () => {
    await nextFocusTask(props);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b" }),
      expect.any(Object),
      expect.objectContaining({ accountId, day, entryId: (await store.read(accountId, day))!.entries[1].id }),
      { sessionId, requestId },
    );
    expect((await store.read(accountId, day))!.entries[0].status).toBe("active");
  });

  it("uses latest order, skips unavailable work and retains a removed current entry as its anchor", async () => {
    await store.update(accountId, day, (plan) => removeEntry(moveEntry(plan, plan.entries[2].id, -1), entryId));
    mocks.sync.mockResolvedValue({ user: { id: accountId }, projects, items: [task("a"), task("b")] });
    await nextFocusTask(props);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b" }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect((await store.read(accountId, day))!.entries.find((entry) => entry.taskId === "c")!.status).toBe(
      "unavailable",
    );
  });

  it("never wraps when the queue has no further active entries", async () => {
    await store.update(accountId, day, (plan) =>
      plan.entries.slice(1).reduce((value, entry) => markCompleted(value, entry.id), plan),
    );
    await nextFocusTask(props);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await result()).toEqual({ sessionId, requestId, success: true, empty: true });
  });

  it("repairs a completed plan entry from the durable native completion marker", async () => {
    const file = join(directory, "state.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.session.queueCompleted = true;
    saved.session.phase = "ended";
    await writeFile(file, JSON.stringify(saved));
    await nextFocusTask(props);
    expect((await store.read(accountId, day))!.entries[0].status).toBe("completed");
  });

  it("leaves the old session unchanged when fresh Todoist data fails", async () => {
    mocks.sync.mockRejectedValue(new Error("Offline"));
    const before = await readFile(join(directory, "state.json"), "utf8");
    await nextFocusTask(props);
    expect(mocks.start).not.toHaveBeenCalled();
    expect((await result()).success).toBe(false);
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe(before);
  });

  it("rejects a different account and stale commands", async () => {
    mocks.sync.mockResolvedValue({ user: { id: "other" }, projects, items: [task("a")] });
    await nextFocusTask(props);
    expect(mocks.start).not.toHaveBeenCalled();
    expect((await result()).error).toContain("annen Todoist-konto");
    await nextFocusTask({
      ...props,
      launchContext: { ...props.launchContext, sessionId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });

  it("does not start a new occurrence of a recurring candidate", async () => {
    await store.update(accountId, day, (plan) => ({
      ...plan,
      entries: plan.entries.map((entry) =>
        entry.taskId === "b" ? { ...entry, occurrence: JSON.stringify(["2026-10-30", null]) } : entry,
      ),
    }));
    const recurring = { ...task("b"), due: { date: "2026-10-31", is_recurring: true } };
    mocks.sync.mockResolvedValue({ user: { id: accountId }, projects, items: [task("a"), recurring, task("c")] });
    await nextFocusTask(props);
    expect(mocks.start.mock.calls[0][0].id).toBe("c");
  });

  it("ignores duplicate in-flight next requests", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.sync.mockImplementationOnce(async () => {
      entered();
      await waiting;
      return { user: { id: accountId }, projects, items: [task("a"), task("b")] };
    });
    const first = nextFocusTask(props);
    await started;
    await nextFocusTask(props);
    release();
    await first;
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
