import type { AddTaskArgs, Task } from "../api";

/** Copy editable task fields, preserving both the next occurrence and its repeat rule. */
export function duplicateTaskPayload(task: Task): AddTaskArgs {
  return {
    content: task.content,
    description: task.description,
    project_id: task.project_id,
    section_id: task.section_id ?? undefined,
    parent_id: task.parent_id ?? undefined,
    child_order: task.child_order,
    labels: [...task.labels],
    priority: task.priority,
    due: task.due
      ? {
          date: task.due.date,
          ...(task.due.is_recurring ? { string: task.due.string } : {}),
          ...(task.due.timezone ? { timezone: task.due.timezone } : {}),
          lang: task.due.lang,
        }
      : undefined,
    ...(task.deadline ? { deadline: { date: task.deadline.date } } : {}),
    ...(task.duration ? { duration: { ...task.duration } } : {}),
    responsible_uid: task.responsible_uid ?? undefined,
  };
}
