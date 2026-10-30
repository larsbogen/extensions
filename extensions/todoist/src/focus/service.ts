import { Cache, environment, getPreferenceValues, showHUD } from "@raycast/api";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CachedDataParams, initialSync, SyncData, Task, updateTask } from "../api";
import { FocusQueueContext, FocusTransitionGuard, showFocusPanel, stopFocusPanel } from "./panel";

export type FocusedTask = { id: string; content: string; projectId?: string };
const emptyFocus: FocusedTask = { id: "", content: "" };

export function readFocusedTask(): FocusedTask {
  try {
    return JSON.parse(new Cache().get("todoist.focusedTask") ?? "null") ?? emptyFocus;
  } catch {
    return emptyFocus;
  }
}

export async function assertFocusTransition(guard: FocusTransitionGuard) {
  const saved = JSON.parse(await readFile(join(environment.supportPath, "focus-panel", "state.json"), "utf8"));
  if (saved.session?.id !== guard.sessionId || saved.session?.pendingNextRequestId !== guard.requestId) {
    throw new Error("Fokusøkten er endret. Åpne arbeidsdagen for å fortsette.");
  }
}

export async function clearFocusedTask(
  state: CachedDataParams,
  options: { automatic?: boolean } = {},
): Promise<boolean> {
  const focused = readFocusedTask();
  if (!focused.id) return true;
  if (options.automatic) {
    try {
      const directory = join(environment.supportPath, "focus-panel");
      const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      if (saved.session?.task?.id === focused.id && saved.session.task.queue) {
        const intent = JSON.parse(await readFile(join(directory, `complete-${saved.session.id}.json`), "utf8"));
        if (intent.sessionId === saved.session.id && intent.taskId === focused.id) return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if ((await stopFocusPanel(focused.id, options.automatic)) === false) return false;
  const label = getPreferenceValues<Preferences>().focusLabelName?.trim();
  if (label) {
    const fresh = (await initialSync()) as SyncData;
    const task = fresh.items.find((task) => task.id === focused.id);
    if (task?.labels.includes(label)) {
      await updateTask(
        { id: task.id, labels: task.labels.filter((value) => value !== label) },
        { data: fresh, setData: state.setData },
      );
    }
  }
  if (readFocusedTask().id === focused.id) new Cache().set("todoist.focusedTask", JSON.stringify(emptyFocus));
  return true;
}

/** Shared entry point for task lists, the workday and the guarded next action. */
export async function startFocusedTask(
  task: Task,
  state: CachedDataParams,
  queue?: FocusQueueContext,
  guard?: FocusTransitionGuard,
): Promise<void> {
  const prefs = getPreferenceValues<Preferences>();
  if (guard) await assertFocusTransition(guard);
  const previous = readFocusedTask();
  // Native next has already paused and checkpointed the old period. It must
  // remain visible if preparation fails, so do not send the ordinary stop/hide.
  if (!guard && previous.id && previous.id !== task.id) await clearFocusedTask(state);
  if (queue && state.data?.user?.id !== queue.accountId)
    throw new Error("Arbeidsdagen tilhører en annen Todoist-konto.");
  const focused = { id: task.id, content: task.content, projectId: task.project_id };
  if (process.platform === "darwin" && (queue || prefs.showFocusWindow !== false)) {
    await showFocusPanel(
      {
        ...focused,
        projectName: state.data?.projects.find((project) => project.id === task.project_id)?.name,
        todoistUserId: state.data?.user?.id,
        queue,
      },
      Number(prefs.focusDuration ?? "25"),
      guard,
    );
  }
  new Cache().set("todoist.focusedTask", JSON.stringify(focused));
  const label = prefs.focusLabelName?.trim();
  if (label) {
    try {
      if (guard && previous.id && previous.id !== task.id) {
        const old = state.data?.items.find((value) => value.id === previous.id);
        if (old?.labels.includes(label)) {
          await updateTask({ id: old.id, labels: old.labels.filter((value) => value !== label) }, state);
        }
      }
      await updateTask({ id: task.id, labels: [...new Set([...task.labels, label])] }, state);
    } catch {
      // The native start is already durably acknowledged. Report a warning,
      // never an apparent failed transition that could encourage another Next.
      await showHUD("Fokuset er startet, men fokusetiketten kunne ikke oppdateres.").catch(() => undefined);
    }
  }
}
