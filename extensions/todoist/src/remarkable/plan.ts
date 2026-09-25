import { randomUUID } from "node:crypto";
import type { Project, Task } from "../api";

export const TIME_ZONE = "Europe/Oslo";
export type PlanTask = {
  id: string;
  title: string;
  parentId?: string;
  parentTitle?: string;
  projectId: string;
  projectName: string;
  priority: number;
  due?: string;
  dueTime?: string;
  deadline?: string;
  duration?: string;
  overdue: boolean;
};
export type PlanSnapshot = {
  version: 1;
  id: string;
  createdAt: string;
  day: string;
  name: string;
  tasks: PlanTask[];
};

export function osloDay(value: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

// All-day and floating dates are calendar values, not UTC instants.
export function dateParts(value: string): { day: string; time?: string } {
  if (!/[Zz]|[+-]\d\d:\d\d$/.test(value)) {
    return { day: value.slice(0, 10), time: value.includes("T") ? value.slice(11, 16) : undefined };
  }
  const date = new Date(value);
  return {
    day: osloDay(date),
    time: new Intl.DateTimeFormat("nb-NO", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date),
  };
}

export function dailyTasks(tasks: Task[], projects: Project[], userId: string, now = new Date()): PlanTask[] {
  const today = osloDay(now);
  const inactive = new Set(projects.filter((p) => p.is_archived || p.is_deleted).map((p) => p.id));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // Sync projects expose sibling order; walk parents to retain the user's project hierarchy.
  const projectOrder: Project[] = [];
  const seen = new Set<string>();
  function visit(parentId: string | null) {
    projects
      .filter((p) => (p.parent_id ?? null) === parentId)
      .sort((a, b) => a.child_order - b.child_order)
      .forEach((p) => {
        if (seen.has(p.id)) return;
        seen.add(p.id);
        projectOrder.push(p);
        visit(p.id);
      });
  }
  visit(null);
  projects.forEach((p) => {
    if (!seen.has(p.id)) projectOrder.push(p);
  });
  const ranks = new Map(projectOrder.map((p, i) => [p.id, i]));
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  return tasks
    .filter(
      (t) =>
        !t.checked &&
        !t.is_deleted &&
        !inactive.has(t.project_id) &&
        (!t.responsible_uid || t.responsible_uid === userId),
    )
    .map((t, index) => {
      const due = t.due?.date ? dateParts(t.due.date) : undefined;
      const deadline = t.deadline?.date ? dateParts(t.deadline.date).day : undefined;
      return { t, index, due, deadline };
    })
    .filter(({ due, deadline }) => (due && due.day <= today) || (deadline && deadline <= today))
    .sort((a, b) => {
      const project = (ranks.get(a.t.project_id) ?? projects.length) - (ranks.get(b.t.project_id) ?? projects.length);
      const overdue = (v: typeof a) => Number(!!((v.due && v.due.day < today) || (v.deadline && v.deadline < today)));
      return (
        project ||
        overdue(b) - overdue(a) ||
        b.t.priority - a.t.priority ||
        (a.due?.time ?? "99:99").localeCompare(b.due?.time ?? "99:99") ||
        a.t.day_order - b.t.day_order ||
        a.t.child_order - b.t.child_order ||
        a.index - b.index
      );
    })
    .map(({ t, due, deadline }) => ({
      id: t.id,
      title: t.content,
      parentId: t.parent_id ?? undefined,
      parentTitle: t.parent_id ? byId.get(t.parent_id)?.content : undefined,
      projectId: t.project_id,
      projectName: projectNames.get(t.project_id) ?? "Ukjent prosjekt",
      priority: 5 - t.priority,
      due: due?.day,
      dueTime: due?.time,
      deadline,
      duration: t.duration ? `${t.duration.amount} ${t.duration.unit === "minute" ? "min" : "dager"}` : undefined,
      overdue: !!((due && due.day < today) || (deadline && deadline < today)),
    }));
}

export function createSnapshot(tasks: PlanTask[], selected: Set<string>, now = new Date()): PlanSnapshot {
  const chosen = tasks.filter((task) => selected.has(task.id));
  if (chosen.length === 0) throw new Error("Velg minst én oppgave.");
  const day = osloDay(now);
  const time = new Intl.DateTimeFormat("nb-NO", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .format(now)
    .replace(/:/g, ".");
  return {
    version: 1,
    id: randomUUID(),
    createdAt: now.toISOString(),
    day,
    name: `Dagsplan – ${day} – ${time}`,
    tasks: chosen.map((t) => ({ ...t })),
  };
}

/** Places selected subtasks directly below their selected parent; other tasks keep snapshot order. */
export function nestTasks(tasks: PlanTask[]): { task: PlanTask; depth: number }[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const nested = (task: PlanTask) => {
    const parent = task.parentId ? byId.get(task.parentId) : undefined;
    return parent !== undefined && parent !== task && parent.projectId === task.projectId;
  };
  const result: { task: PlanTask; depth: number }[] = [];
  const placed = new Set<string>();
  function place(task: PlanTask, depth: number) {
    if (placed.has(task.id)) return;
    placed.add(task.id);
    result.push({ task, depth });
    tasks.filter((child) => child.parentId === task.id && nested(child)).forEach((child) => place(child, depth + 1));
  }
  tasks.filter((task) => !nested(task)).forEach((task) => place(task, 0));
  // A parent cycle cannot come from Todoist, but must never drop a task.
  tasks.forEach((task) => place(task, 0));
  return result;
}
