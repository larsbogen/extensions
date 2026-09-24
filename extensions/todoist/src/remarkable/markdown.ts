import type { PlanSnapshot } from "./plan";

// Treat Todoist content as text. No task may inject HTML, metadata, CSS or a page break.
export function escapeText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/([\\`*_{}[\]()#+.!|~-])/g, "\\$1");
}

/** Retained human-readable snapshot; PDF generation does not parse this file. */
export function planMarkdown(snapshot: PlanSnapshot): string {
  const lines = [`# ${snapshot.name}`, "", `${snapshot.tasks.length} oppgaver · Europe/Oslo`, ""];
  let projectId: string | undefined;
  for (const task of snapshot.tasks) {
    if (task.projectId !== projectId) {
      lines.push(`## ${escapeText(task.projectName)}`, "");
      projectId = task.projectId;
    }
    lines.push(`- [ ] ${escapeText(task.title)}`);
    if (task.parentTitle) lines.push(`  Underoppgave av: ${escapeText(task.parentTitle)}`);
    const details = [
      task.overdue ? "Forfalt" : undefined,
      task.due ? `Dato: ${task.due}${task.dueTime ? ` kl. ${task.dueTime}` : ""}` : undefined,
      `P${task.priority}`,
      task.deadline ? `Deadline: ${task.deadline}` : undefined,
      task.duration,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(
      `  ${escapeText(details)}`,
      "",
      "  ________________________________________",
      "",
      "  ________________________________________",
      "",
    );
  }
  lines.push("## Notater", "", ...Array.from({ length: 8 }, () => "________________________________________\n"));
  return lines.join("\n");
}
