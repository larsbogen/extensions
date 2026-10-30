import { Cache, environment, getPreferenceValues, LaunchProps, showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { closeTask, initialSync, SyncData, updateTask } from "./api";
import { refreshMenuBarCommand } from "./helpers/menu-bar";
import { withTodoistApi } from "./helpers/withTodoistApi";
import { markCompleted, occurrenceKey } from "./workday/model";
import { getWorkdayStore } from "./workday/runtime";
import { acquireFocusLock, writeFocusJson } from "./focus/storage";

type Context = { sessionId?: string; taskId?: string };

export async function completeFocusedTask({ launchContext }: LaunchProps<{ launchContext: Context }>) {
  const directory = join(environment.supportPath, "focus-panel");
  const { sessionId, taskId } = launchContext ?? {};
  // Only a particular card can request completion; an old link must never complete a new focus task.
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId) || !taskId) {
    await showToast({ style: Toast.Style.Failure, title: "Bruk «Fullfør oppgave» i fokusvinduet" });
    return;
  }
  const lock = join(directory, `complete-${sessionId}.lock`);
  const intentFile = join(directory, `complete-${sessionId}.json`);
  let release: (() => Promise<void>) | undefined;
  let completed = false;
  let warning: string | undefined;
  const cache = new Cache();
  const readSession = async () => JSON.parse(await readFile(join(directory, "state.json"), "utf8")).session;
  async function result(success: boolean, error?: string) {
    await writeFocusJson(join(directory, "completion.json"), { sessionId, success, error });
  }
  try {
    const session = await readSession();
    if (session?.id !== sessionId || session.task?.id !== taskId || session.phase === "ended") return;
    release = await acquireFocusLock(lock);
    if (!release) return;
    let data = (await initialSync()) as SyncData;
    const queue = session.task?.queue;
    if (
      (queue && data.user?.id !== queue.accountId) ||
      (session.task.todoistUserId && data.user?.id !== session.task.todoistUserId)
    )
      throw new Error("Fokusoppgaven tilhører en annen Todoist-konto.");
    const beforeClose = await readSession();
    if (beforeClose?.id !== sessionId || beforeClose.task?.id !== taskId) return;
    let intent: { sessionId: string; taskId: string; confirmed?: boolean } | undefined;
    try {
      intent = JSON.parse(await readFile(intentFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (intent && (intent.sessionId !== sessionId || intent.taskId !== taskId))
      throw new Error("Fullføringskvitteringen er ugyldig.");
    if (intent?.confirmed) {
      await result(true);
      return;
    }
    // A persisted intent may have succeeded remotely before a connection failed.
    // Retry only its original idempotency key, even if recurrence has advanced.
    if (queue && !intent) {
      const plan = await getWorkdayStore().read(queue.accountId, queue.day);
      const entry = plan?.entries.find((entry) => entry.id === queue.entryId);
      const task = data.items.find((task) => task.id === taskId);
      if (!entry || entry.taskId !== taskId || !task || occurrenceKey(task) !== entry.occurrence) {
        throw new Error("Oppgaveforekomsten er endret. Oppdater arbeidsdagen før du fortsetter.");
      }
    }
    const state = {
      data,
      setData: (value: React.SetStateAction<SyncData | undefined>) => {
        data = (typeof value === "function" ? value(data) : value) as SyncData;
        cache.set("data", JSON.stringify(data));
      },
    };
    // Persist before the remote call: a new occurrence must never receive a new
    // completion command merely because the first response was lost.
    if (!intent) await writeFocusJson(intentFile, { sessionId, taskId });
    // Reusing the session UUID makes retries safe for recurring tasks, including uncertain network outcomes.
    await closeTask(taskId, state, sessionId);
    completed = true;
    if (queue) {
      try {
        await getWorkdayStore().update(queue.accountId, queue.day, (plan) => markCompleted(plan, queue.entryId));
      } catch {
        warning = "Oppgaven er fullført, men arbeidsdagen kunne ikke lagres. Køen prøver igjen ved Neste oppgave.";
      }
    }
    const focused = JSON.parse(cache.get("todoist.focusedTask") ?? "null");
    const current = await readSession();
    if (focused?.id === taskId && current?.id === sessionId) {
      cache.set("todoist.focusedTask", JSON.stringify({ id: "", content: "" }));
      const label = getPreferenceValues<Preferences>().focusLabelName?.trim();
      const nextOccurrence = data.items.find((task) => task.id === taskId);
      if (label && nextOccurrence?.labels.includes(label)) {
        try {
          await updateTask({ id: taskId, labels: nextOccurrence.labels.filter((value) => value !== label) }, state);
        } catch {
          warning = [warning, "Oppgaven er fullført, men fokusetiketten kunne ikke fjernes."].filter(Boolean).join(" ");
        }
      }
    }
    const latest = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    const pendingToggl = latest.tracking?.periods?.some(
      (period: { sessionID: string; sync: string }) =>
        period.sessionID === sessionId && !["local", "synced", "accepted"].includes(period.sync),
    );
    if (pendingToggl) {
      warning = [warning, "Toggl venter på synkronisering. En ekstern timer kan fortsatt gå."]
        .filter(Boolean)
        .join(" ");
    }
    await writeFocusJson(intentFile, { sessionId, taskId, confirmed: true });
    await result(true);
    await refreshMenuBarCommand();
    await showToast({
      style: Toast.Style.Success,
      title: "Oppgaven er fullført og fokuset er stoppet",
      message: warning,
    });
  } catch (error) {
    await result(completed, completed ? undefined : "Kunne ikke fullføre oppgaven. Prøv igjen.").catch(() => undefined);
    await showFailureToast(error, {
      title: completed
        ? "Oppgaven er fullført, men fokusstatusen kunne ikke oppdateres"
        : "Kunne ikke fullføre oppgaven",
    });
  } finally {
    if (release) await release();
  }
}

export default withTodoistApi(completeFocusedTask);
