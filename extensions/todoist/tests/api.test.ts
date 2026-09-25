import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../src/helpers/withTodoistApi", () => ({ getTodoistApi: () => client }));

import {
  addLabel,
  closeTask,
  getFilterTasks,
  moveTask,
  updateComment,
  updateFilter,
  updateLabel,
  updateProject,
  updateTask,
  updateTasks,
  type SyncData,
} from "../src/api";

function cache(initial: Partial<SyncData>) {
  let data = { reminders: [], ...initial } as SyncData;
  return {
    get data() {
      return data;
    },
    setData: (updater: React.SetStateAction<SyncData | undefined>) => {
      data = (typeof updater === "function" ? updater(data) : updater) as SyncData;
    },
  };
}

beforeEach(() => vi.resetAllMocks());

describe("filter pagination", () => {
  it("fetches all pages and keeps the filter and language on every request", async () => {
    client.get
      .mockResolvedValueOnce({ data: { results: [{ id: "a" }], next_cursor: "page-2" } })
      .mockResolvedValueOnce({ data: { results: [], next_cursor: "page-3" } })
      .mockResolvedValueOnce({ data: { results: [{ id: "b" }], next_cursor: null } });
    expect(await getFilterTasks("today | overdue", "nb")).toEqual([{ id: "a" }, { id: "b" }]);
    expect(client.get).toHaveBeenCalledTimes(3);
    expect(client.get).toHaveBeenNthCalledWith(1, "/tasks/filter", {
      params: { query: "today | overdue", lang: "nb" },
    });
    expect(client.get).toHaveBeenNthCalledWith(2, "/tasks/filter", {
      params: { query: "today | overdue", lang: "nb", cursor: "page-2" },
    });
    expect(client.get).toHaveBeenNthCalledWith(3, "/tasks/filter", {
      params: { query: "today | overdue", lang: "nb", cursor: "page-3" },
    });
  });

  it("stops on an empty final page", async () => {
    client.get.mockResolvedValueOnce({ data: { results: [], next_cursor: null } });
    expect(await getFilterTasks("today")).toEqual([]);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("fails visibly instead of returning a partial list when a later page fails", async () => {
    client.get.mockResolvedValueOnce({ data: { results: [{ id: "a" }], next_cursor: "next" } });
    client.get.mockRejectedValueOnce(new Error("rate limited"));
    await expect(getFilterTasks("today")).rejects.toThrow("rate limited");
  });
});

describe("sync responses", () => {
  it("matches the edited task by ID and applies other changes regardless of response order", async () => {
    const state = cache({
      items: [
        { id: "a", content: "old a" },
        { id: "b", content: "old b" },
      ] as SyncData["items"],
    });
    const a = { id: "a", content: "new a" };
    const b = { id: "b", content: "new b" };
    client.post.mockResolvedValueOnce({ data: { sync_token: "next", items: [b, a], reminders: [] } });
    const onSynced = vi.fn();
    expect(await updateTask({ id: "a", content: "new a" }, state, onSynced)).toBe(true);
    expect(state.data.items).toEqual([a, b]);
    expect(onSynced).toHaveBeenCalledWith({ updatedTask: a, syncReminders: [] });
  });

  it("never runs the edited-task callback for an unrelated row", async () => {
    const state = cache({ items: [{ id: "a" }, { id: "b" }] as SyncData["items"] });
    client.post.mockResolvedValueOnce({ data: { sync_token: "next", items: [{ id: "b", content: "new b" }] } });
    const onSynced = vi.fn();
    expect(await updateTask({ id: "a" }, state, onSynced)).toBe(false);
    expect(state.data.items[0]).toEqual({ id: "a" });
    expect(state.data.items[1].content).toBe("new b");
    expect(onSynced).not.toHaveBeenCalled();
  });

  it("applies reminder deltas even if no task row is returned", async () => {
    const state = cache({
      items: [{ id: "a" }] as SyncData["items"],
      reminders: [{ id: "r", item_id: "a" }] as SyncData["reminders"],
    });
    client.post.mockResolvedValueOnce({
      data: { sync_token: "next", items: [], reminders: [{ id: "r", is_deleted: 1 }] },
    });
    expect(await updateTask({ id: "a" }, state)).toBe(false);
    expect(state.data.items).toEqual([{ id: "a" }]);
    expect(state.data.reminders).toEqual([]);
  });

  it.each([
    ["task move", "items", moveTask],
    ["project edit", "projects", updateProject],
    ["label edit", "labels", updateLabel],
    ["filter edit", "filters", updateFilter],
    ["comment edit", "notes", updateComment],
  ] as const)("merges reordered changes for %s", async (_name, field, mutate) => {
    const state = cache({ [field]: [{ id: "a" }, { id: "b" }, { id: "keep" }, { id: "remove" }] });
    const a = { id: "a", content: "updated a" };
    const b = { id: "b", content: "updated b" };
    client.post.mockResolvedValueOnce({
      data: { sync_token: "next", [field]: [b, { id: "remove", is_deleted: true }, a, { id: "new" }] },
    });
    await mutate({ id: "a", content: "updated a" }, state);
    expect(state.data[field]).toEqual([a, b, { id: "keep" }, { id: "new" }]);
  });

  it("does not duplicate labels when a full sync is returned while adding a label", async () => {
    const state = cache({ labels: [{ id: "old" }] as SyncData["labels"] });
    client.post.mockResolvedValueOnce({
      data: { sync_token: "next", full_sync: true, labels: [{ id: "old" }, { id: "new" }] },
    });
    await addLabel({ name: "new" }, state);
    expect(state.data.labels).toEqual([{ id: "old" }, { id: "new" }]);
  });

  it("preserves the next recurring occurrence and merges unrelated changes on completion", async () => {
    const state = cache({ items: [{ id: "a" }, { id: "b" }] as SyncData["items"] });
    const nextOccurrence = { id: "a", due: { date: "2026-09-25", is_recurring: true }, checked: false };
    client.post.mockResolvedValueOnce({
      data: { sync_token: "next", items: [{ id: "b", content: "changed" }, nextOccurrence] },
    });
    await closeTask("a", state);
    expect(state.data.items).toEqual([nextOccurrence, { id: "b", content: "changed" }]);
  });

  it("removes a completed one-off task when no row is returned", async () => {
    const state = cache({ items: [{ id: "a" }, { id: "keep" }] as SyncData["items"] });
    client.post.mockResolvedValueOnce({ data: { sync_token: "next", items: [] } });
    await closeTask("a", state);
    expect(state.data.items).toEqual([{ id: "keep" }]);
  });

  it("does not mutate the cache if Todoist rejects the update", async () => {
    const state = cache({ items: [{ id: "a" }] as SyncData["items"] });
    client.post.mockResolvedValueOnce({ data: { sync_status: { command: { error: "forbidden", error_code: 403 } } } });
    await expect(updateTask({ id: "a" }, state)).rejects.toThrow("forbidden");
    expect(state.data.items).toEqual([{ id: "a" }]);
  });
});

describe("batch task updates", () => {
  it("sends one command per task in a single request and merges every returned row", async () => {
    const state = cache({ items: [{ id: "a" }, { id: "b" }, { id: "keep" }] as SyncData["items"] });
    const a = { id: "a", due: { date: "2026-09-25", string: "every day", is_recurring: true } };
    const b = { id: "b", due: { date: "2026-09-25", string: "every day", is_recurring: true } };
    client.post.mockResolvedValueOnce({ data: { sync_token: "next", items: [b, a] } });
    await updateTasks(
      [
        { id: "a", due: { date: "2026-09-25", string: "every day" } },
        { id: "b", due: { date: "2026-09-25", string: "every day" } },
      ],
      state,
    );
    expect(client.post).toHaveBeenCalledTimes(1);
    const { commands } = client.post.mock.calls[0][1];
    expect(commands.map((c: { type: string; args: { id: string } }) => [c.type, c.args.id])).toEqual([
      ["item_update", "a"],
      ["item_update", "b"],
    ]);
    expect(state.data.items).toEqual([a, b, { id: "keep" }]);
  });

  it("splits more than 100 tasks across requests", async () => {
    const state = cache({ items: [] });
    client.post.mockResolvedValue({ data: { sync_token: "next", items: [] } });
    await updateTasks(
      Array.from({ length: 150 }, (_, i) => ({ id: `${i}` })),
      state,
    );
    expect(client.post.mock.calls.map(([, params]) => params.commands.length)).toEqual([100, 50]);
  });

  it("fails when any command in the batch is rejected, not only the first", async () => {
    const state = cache({ items: [{ id: "a" }, { id: "b" }] as SyncData["items"] });
    client.post.mockResolvedValueOnce({
      data: { sync_status: { first: "ok", second: { error: "Invalid argument value", error_code: 20 } } },
    });
    await expect(updateTasks([{ id: "a" }, { id: "b" }], state)).rejects.toThrow("Invalid argument value");
    expect(state.data.items).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
