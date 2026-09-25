import { describe, expect, it } from "vitest";
import type { Project, Task } from "../src/api";
import { createSnapshot, dailyTasks, dateParts, nestTasks, osloDay } from "../src/remarkable/plan";
import { planMarkdown } from "../src/remarkable/markdown";

const projects = [
  { id: "work", name: "Arbeid", child_order: 1, parent_id: null },
  { id: "home", name: "Hjem", child_order: 0, parent_id: null },
] as Project[];
const task = (id: string, patch: Partial<Task> = {}) =>
  ({
    id,
    content: id,
    project_id: "home",
    checked: false,
    is_deleted: false,
    priority: 1,
    child_order: 0,
    day_order: 0,
    responsible_uid: null,
    due: { date: "2026-09-24" },
    ...patch,
  }) as Task;
const now = new Date("2026-09-24T12:00:00Z");

describe("Oslo daily selection", () => {
  it("uses Oslo midnight rather than UTC or the computer timezone", () => {
    expect(osloDay(new Date("2026-09-23T22:01:00Z"))).toBe("2026-09-24");
    expect(dateParts("2026-09-23T22:01:00Z")).toEqual({ day: "2026-09-24", time: "00:01" });
    expect(dateParts("2026-09-24")).toEqual({ day: "2026-09-24", time: undefined });
    expect(dateParts("2026-09-24T08:15:00").time).toBe("08:15");
  });
  it("handles both summer-time transitions", () => {
    expect(dateParts("2026-03-29T01:30:00Z").time).toBe("03:30");
    expect(dateParts("2026-10-25T01:30:00Z").time).toBe("02:30");
  });
  it("includes overdue and deadline-only tasks, excludes completed, deleted, future and other assignees", () => {
    const tasks = [
      task("today"),
      task("overdue", { due: { date: "2026-09-20" } as Task["due"] }),
      task("deadline", { due: null, deadline: { date: "2026-09-24" } as Task["deadline"] }),
      task("mine", { responsible_uid: "me" }),
      task("theirs", { responsible_uid: "other" }),
      task("deleted", { is_deleted: true }),
      task("done", { checked: true }),
      task("future", { due: { date: "2026-09-25" } as Task["due"] }),
      task("undated", { due: null }),
    ];
    expect(dailyTasks(tasks, projects, "me", now).map((t) => t.id)).toEqual(["overdue", "today", "deadline", "mine"]);
  });
  it("keeps project order, then overdue, priority, time, and Todoist order", () => {
    const tasks = [
      task("work", { project_id: "work", priority: 4 }),
      task("normal"),
      task("urgent", { priority: 4 }),
      task("overdue", { due: { date: "2026-09-20" } as Task["due"] }),
      task("timed", { due: { date: "2026-09-24T10:00:00" } as Task["due"] }),
    ];
    expect(dailyTasks(tasks, projects, "me", now).map((t) => t.id)).toEqual([
      "overdue",
      "urgent",
      "timed",
      "normal",
      "work",
    ]);
  });
  it("adds parent context without adding the undated parent or sibling", () => {
    const result = dailyTasks(
      [
        task("parent", { due: null }),
        task("child", { parent_id: "parent" }),
        task("sibling", { due: null, parent_id: "parent" }),
      ],
      projects,
      "me",
      now,
    );
    expect(result).toHaveLength(1);
    expect(result[0].parentTitle).toBe("parent");
    expect(result[0].parentId).toBe("parent");
  });
  it("nests selected subtasks below their parent without dropping or reordering other tasks", () => {
    const result = dailyTasks(
      [
        task("child", { priority: 4, parent_id: "parent" }),
        task("other"),
        task("parent"),
        task("grandchild", { parent_id: "child" }),
        task("elsewhere", { project_id: "work", parent_id: "parent" }),
      ],
      projects,
      "me",
      now,
    );
    expect(nestTasks(result).map(({ task, depth }) => `${task.id}:${depth}`)).toEqual([
      "other:0",
      "parent:0",
      "child:1",
      "grandchild:2",
      "elsewhere:0",
    ]);
  });
});

describe("frozen export and print content", () => {
  it("rejects empty selections and does not change a snapshot after selection or source changes", () => {
    const tasks = dailyTasks([task("a"), task("b")], projects, "me", now);
    expect(() => createSnapshot(tasks, new Set(), now)).toThrow("Velg minst");
    const selection = new Set(["a"]);
    const snapshot = createSnapshot(tasks, selection, now);
    selection.add("b");
    tasks[0].title = "modified";
    expect(snapshot.tasks.map((t) => t.title)).toEqual(["a"]);
    expect(snapshot.name).toBe("Dagsplan – 2026-09-24 – 14.00.00");
  });
  it("escapes HTML and Markdown content while retaining Norwegian text and writing lines", () => {
    const tasks = dailyTasks(
      [
        task("a", { content: 'Ærlig ønske <script>alert("x")</script> & <!--BREAK-->\nTitle: injected' }),
        task("b", { project_id: "work" }),
      ],
      projects,
      "me",
      now,
    );
    const markdown = planMarkdown(createSnapshot(tasks, new Set(["a", "b"]), now));
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("<!--BREAK-->");
    expect(markdown).toContain("Ærlig ønske &lt;script&gt;");
    expect(markdown).toContain("## Hjem");
    expect(markdown).toContain("## Arbeid");
    expect(markdown.match(/_{40}/g)).toHaveLength(12);
  });
});
