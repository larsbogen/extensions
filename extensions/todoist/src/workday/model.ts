import { randomUUID } from "node:crypto";
import type { Project, Task } from "../api";
import { dateParts, osloDay } from "../remarkable/plan";

export type WorkdayEntry = {
  id: string;
  taskId: string;
  occurrence: string | null;
  status: "active" | "completed" | "unavailable" | "removed";
  addedAt: string;
  title: string;
  projectId: string;
  projectName: string;
};
export type WorkdayPlan = {
  version: 1;
  accountId: string;
  day: string;
  revision: number;
  entries: WorkdayEntry[];
  topThree: string[];
};
export type WorkdayCompletion = { taskId: string; completedAt: string };

export function createWorkday(accountId: string, day = osloDay(new Date())): WorkdayPlan {
  return { version: 1, accountId, day, revision: 0, entries: [], topThree: [] };
}

export function occurrenceKey(task: Task): string | null {
  return task.due?.is_recurring ? JSON.stringify([task.due.date, task.due.timezone ?? null]) : null;
}

export function eligibleTasks(tasks: Task[], projects: Project[], userId: string): Task[] {
  const active = new Set(projects.filter((p) => !p.is_archived && !p.is_deleted).map((p) => p.id));
  return tasks.filter(
    (task) =>
      !task.checked &&
      !task.is_deleted &&
      active.has(task.project_id) &&
      (!task.responsible_uid || task.responsible_uid === userId),
  );
}

export function isSuggested(task: Task, day: string): boolean {
  return [task.due?.date, task.deadline?.date].some((date) => date && dateParts(date).day <= day);
}

export function activeEntries(plan: WorkdayPlan): WorkdayEntry[] {
  return plan.entries.filter((entry) => entry.status === "active");
}

export function addTaskToPlan(plan: WorkdayPlan, task: Task, projects: Project[], now = new Date()): WorkdayPlan {
  if (!eligibleTasks([task], projects, plan.accountId).length)
    throw new Error("Oppgaven er ikke tilgjengelig for din arbeidsdag.");
  if (activeEntries(plan).some((entry) => entry.taskId === task.id)) return plan;
  return {
    ...plan,
    entries: [
      ...plan.entries,
      {
        id: randomUUID(),
        taskId: task.id,
        occurrence: occurrenceKey(task),
        status: "active",
        addedAt: now.toISOString(),
        title: task.content,
        projectId: task.project_id,
        projectName: projects.find((project) => project.id === task.project_id)?.name ?? "Ukjent prosjekt",
      },
    ],
  };
}

export function removeEntry(plan: WorkdayPlan, entryId: string): WorkdayPlan {
  return {
    ...plan,
    entries: plan.entries.map((entry) => (entry.id === entryId ? { ...entry, status: "removed" } : entry)),
    topThree: plan.topThree.filter((id) => id !== entryId),
  };
}

export function markCompleted(plan: WorkdayPlan, entryId: string): WorkdayPlan {
  return {
    ...plan,
    entries: plan.entries.map((entry) =>
      entry.id === entryId && entry.status !== "removed" ? { ...entry, status: "completed" } : entry,
    ),
  };
}

export function toggleTopThree(plan: WorkdayPlan, entryId: string): WorkdayPlan {
  if (plan.topThree.includes(entryId)) return { ...plan, topThree: plan.topThree.filter((id) => id !== entryId) };
  if (!activeEntries(plan).some((entry) => entry.id === entryId)) return plan;
  // Completed highlights do not consume one of today's three remaining slots.
  const topThree = plan.topThree.filter((id) => activeEntries(plan).some((entry) => entry.id === id));
  if (topThree.length >= 3) throw new Error("Du har valgt tre fokusoppgaver. Fjern en markering først.");
  return { ...plan, topThree: [...topThree, entryId] };
}

export function moveEntry(plan: WorkdayPlan, entryId: string, direction: -1 | 1): WorkdayPlan {
  const active = activeEntries(plan);
  const index = active.findIndex((entry) => entry.id === entryId);
  const other = active[index + direction];
  if (index < 0 || !other) return plan;
  const entries = [...plan.entries];
  const left = entries.findIndex((entry) => entry.id === entryId);
  const right = entries.findIndex((entry) => entry.id === other.id);
  [entries[left], entries[right]] = [entries[right], entries[left]];
  return { ...plan, entries };
}

export function nextEntry(plan: WorkdayPlan, entryId: string): WorkdayEntry | undefined {
  const index = plan.entries.findIndex((entry) => entry.id === entryId);
  return index < 0 ? undefined : plan.entries.slice(index + 1).find((entry) => entry.status === "active");
}

export function reconcilePlan(
  plan: WorkdayPlan,
  tasks: Task[],
  projects: Project[],
  userId: string,
  completions: WorkdayCompletion[] = [],
  observedAt?: string,
): WorkdayPlan {
  if (plan.accountId !== userId) throw new Error("Arbeidsdagen tilhører en annen Todoist-konto.");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const eligible = new Set(eligibleTasks(tasks, projects, userId).map((task) => task.id));
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return {
    ...plan,
    entries: plan.entries.map((entry) => {
      if (observedAt && Date.parse(entry.addedAt) > Date.parse(observedAt)) return entry;
      if (entry.status === "removed" || entry.status === "completed") return entry;
      const task = byId.get(entry.taskId);
      if (
        task?.checked ||
        completions.some(
          (event) => event.taskId === entry.taskId && Date.parse(event.completedAt) >= Date.parse(entry.addedAt),
        )
      )
        return { ...entry, status: "completed" };
      if (!task || !eligible.has(task.id) || occurrenceKey(task) !== entry.occurrence) {
        return { ...entry, status: "unavailable" };
      }
      return {
        ...entry,
        title: task.content,
        projectId: task.project_id,
        projectName: names.get(task.project_id) ?? entry.projectName,
      };
    }),
  };
}

export function carryCandidates(
  previous: WorkdayPlan | undefined,
  tasks: Task[],
  projects: Project[],
  userId: string,
): Task[] {
  if (!previous || previous.accountId !== userId) return [];
  const byId = new Map(eligibleTasks(tasks, projects, userId).map((task) => [task.id, task]));
  return activeEntries(previous).flatMap((entry) => {
    const task = byId.get(entry.taskId);
    return task && occurrenceKey(task) === entry.occurrence ? [task] : [];
  });
}
