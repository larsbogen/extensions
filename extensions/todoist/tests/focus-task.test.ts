import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncData, Task } from "../src/api";

const mocks = vi.hoisted(() => ({
  environment: { supportPath: "" },
  sync: vi.fn(),
  start: vi.fn(),
  existing: vi.fn(),
  readFocus: vi.fn(),
  refresh: vi.fn(),
  hud: vi.fn(),
  cache: new Map<string, string>(),
}));
vi.mock("@raycast/api", () => ({
  environment: mocks.environment,
  Cache: class {
    set(key: string, value: string) {
      mocks.cache.set(key, value);
    }
  },
  showHUD: mocks.hud,
}));
vi.mock("../src/api", () => ({ initialSync: mocks.sync }));
vi.mock("../src/focus/service", () => ({ startFocusedTask: mocks.start, readFocusedTask: mocks.readFocus }));
vi.mock("../src/focus/panel", () => ({ showExistingFocusPanel: mocks.existing }));
vi.mock("../src/helpers/menu-bar", () => ({ refreshMenuBarCommand: mocks.refresh }));
vi.mock("../src/helpers/withTodoistApi", () => ({ withTodoistApi: (fn: unknown) => fn }));
import { focusTask, FocusTaskContext, FocusTaskReceipt } from "../src/focus-task";
import { createHmac } from "node:crypto";
import { createFocusServer } from "../integrations/focus-context-menu/service.mjs";

const requestId = "22222222-2222-4222-8222-222222222222";
const task = { id: "6gTask123", content: "Fresh API title", project_id: "project1", labels: [] } as unknown as Task;
const data = {
  user: { id: "owner" },
  projects: [{ id: "project1", name: "Project" }],
  items: [task],
} as SyncData;
let context: FocusTaskContext;
function run(launchContext: FocusTaskContext | undefined = context) {
  return focusTask({ arguments: {}, launchContext, launchType: "userInitiated" } as Parameters<typeof focusTask>[0]);
}
function receipt(id = requestId): Promise<FocusTaskReceipt> {
  return readFile(join(mocks.environment.supportPath, "focus-requests", `${id}.json`), "utf8").then(JSON.parse);
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.cache.clear();
  mocks.environment.supportPath = await mkdtemp(join(tmpdir(), "todoist-start-focus-test-"));
  mocks.sync.mockResolvedValue(data);
  mocks.readFocus.mockReturnValue({ id: "previous", content: "Previous" });
  mocks.existing.mockResolvedValue(false);
  mocks.refresh.mockResolvedValue(undefined);
  context = { taskId: task.id, accountId: "owner", requestId, issuedAt: new Date().toISOString() };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(mocks.environment.supportPath, { recursive: true, force: true });
});

describe("official Todoist focus entry point", () => {
  it("connects a signed Todoist menu callback to the real command without a second card action", async () => {
    const verificationToken = "test-bridge-key-0123456789abcdef";
    const server = await createFocusServer(
      { accountId: "owner", verificationToken },
      {
        launch: async (link: string) => {
          const url = new URL(link);
          expect(url.protocol).toBe("raycast:");
          expect(url.hostname + url.pathname).toBe("extensions/doist/todoist/focus-task");
          expect(url.searchParams.get("launchType")).toBe("background");
          context = JSON.parse(url.searchParams.get("context")!);
          await run(context);
        },
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const body = JSON.stringify({
        extensionType: "context-menu",
        context: { user: { id: "owner" } },
        action: { actionType: "initial", params: { source: "task", sourceId: task.id, content: "Ignored title" } },
      });
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/process`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-todoist-hmac-sha256": createHmac("sha256", verificationToken).update(body).digest("base64"),
        },
        body,
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).not.toHaveProperty("card");
      expect(result.bridges).toContainEqual({ bridgeActionType: "finished" });
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(mocks.start.mock.calls[0][0].content).toBe("Fresh API title");
      expect(await receipt(context.requestId!)).toMatchObject({ status: "started", taskId: task.id });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("starts the current API task through the existing focus service and acknowledges only afterward", async () => {
    mocks.start.mockImplementation(async (value, state) => {
      expect(value).toBe(task);
      expect(await receipt()).toMatchObject({ status: "pending", taskId: task.id, accountId: "owner" });
      state.setData((before: SyncData) => ({ ...before, items: [] }));
    });
    await run();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith(task, expect.any(Object), undefined, undefined, { forcePanel: true });
    expect(await receipt()).toMatchObject({ version: 1, ...context, status: "started" });
    expect(JSON.parse(mocks.cache.get("data")!).items).toEqual([]);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("allows a local task-ID-only launch without manufacturing an external receipt", async () => {
    await run({ taskId: task.id });
    expect(mocks.start).toHaveBeenCalledOnce();
    await expect(receipt()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    {},
    { taskId: "../state" },
    { taskId: task.id, accountId: "https://other" },
    { taskId: task.id, requestId: "../../file", issuedAt: "2026-11-12T10:00:00.000Z" },
    { taskId: task.id, requestId },
    { taskId: task.id, issuedAt: "2026-11-12T10:00:00.000Z" },
    { taskId: task.id, requestId, issuedAt: "invalid" },
  ])("rejects malformed context before fetching tasks: %j", async (value) => {
    await run(value);
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.hud).toHaveBeenCalledOnce();
  });

  it.each([-6 * 60 * 1000, 60000])("rejects expired or future requests (%i ms)", async (offset) => {
    context.issuedAt = new Date(Date.now() + offset).toISOString();
    await run();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect((await receipt()).status).toBe("failed");
  });

  it("does not touch the current focus when API access fails", async () => {
    mocks.sync.mockRejectedValue(new Error("Offline"));
    await run();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.existing).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({ status: "failed", error: "Offline" });
  });

  it.each([
    { items: [] },
    { items: [{ ...task, checked: true }] },
    { items: [{ ...task, is_deleted: true }] },
    { items: [{ ...task, completed_at: "2026-11-12T10:00:00Z" }] },
    { projects: [] },
    { projects: [{ id: task.project_id, is_archived: true }] },
    { projects: [{ id: task.project_id, is_deleted: true }] },
    { user: { id: "another-account" } },
  ])("retains focus for an unavailable task/project or wrong account: %j", async (change) => {
    mocks.sync.mockResolvedValue({ ...data, ...change });
    await run();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.existing).not.toHaveBeenCalled();
    expect((await receipt()).status).toBe("failed");
  });

  it("shows an existing session without resetting its timer or queue", async () => {
    mocks.readFocus.mockReturnValue({ id: task.id, content: task.content });
    mocks.existing.mockResolvedValue(true);
    await run();
    expect(mocks.existing).toHaveBeenCalledWith(task.id);
    expect(mocks.start).not.toHaveBeenCalled();
    expect((await receipt()).status).toBe("started");
  });

  it("starts again when a task's previous session has ended", async () => {
    mocks.readFocus.mockReturnValue({ id: task.id, content: task.content });
    await run();
    expect(mocks.existing).toHaveBeenCalledWith(task.id);
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("does not replay an old successful request after the user switched focus", async () => {
    await run();
    const saved = await receipt();
    mocks.readFocus.mockReturnValue({ id: "some-other-task", content: "Changed" });
    await run();
    expect(mocks.sync).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(await receipt()).toEqual(saved);
  });

  it("keeps an uncertain native result and refuses to execute it again", async () => {
    mocks.start.mockRejectedValue(new Error("Native acknowledgement timed out"));
    await run();
    expect(await receipt()).toMatchObject({ status: "unknown", error: "Native acknowledgement timed out" });
    await run();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.sync).toHaveBeenCalledOnce();
  });

  it("rejects reuse of an ID with different context without replacing the original receipt", async () => {
    await run();
    const saved = await receipt();
    await run({ ...context, taskId: "different-task" });
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(await receipt()).toEqual(saved);
    expect(mocks.hud).toHaveBeenCalledWith(expect.stringContaining("allerede brukt"));
  });

  it("does not replay or replace an unreadable prior receipt", async () => {
    await run();
    const file = join(mocks.environment.supportPath, "focus-requests", `${requestId}.json`);
    await writeFile(file, "unreadable receipt");
    await run();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(await readFile(file, "utf8")).toBe("unreadable receipt");
  });

  it("does not overwrite a user focus change while fresh data was fetched", async () => {
    mocks.sync.mockImplementation(async () => {
      mocks.readFocus.mockReturnValue({ id: "user-changed", content: "New task" });
      return data;
    });
    await run();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({ status: "failed", error: expect.stringContaining("ble endret") });
  });

  it("rechecks request expiry after fetching current task data", async () => {
    const issued = Date.parse(context.issuedAt!);
    mocks.sync.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(issued + 6 * 60 * 1000);
      return data;
    });
    await run();
    expect(mocks.start).not.toHaveBeenCalled();
    expect((await receipt()).status).toBe("failed");
  });

  it("suppresses concurrent external starts without overwriting the owner's receipt", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    mocks.sync.mockImplementationOnce(async () => {
      entered();
      await waiting;
      return data;
    });
    const first = run();
    await started;
    await run();
    await run({ ...context, requestId: "33333333-3333-4333-8333-333333333333" });
    expect(mocks.start).not.toHaveBeenCalled();
    await expect(receipt()).rejects.toMatchObject({ code: "ENOENT" });
    release();
    await first;
    expect(mocks.start).toHaveBeenCalledOnce();
    expect((await receipt()).status).toBe("started");
  });
});
