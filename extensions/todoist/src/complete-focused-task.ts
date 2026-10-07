import { Cache, environment, getPreferenceValues, LaunchProps, showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { closeTask, initialSync, SyncData, updateTask } from "./api";
import { refreshMenuBarCommand } from "./helpers/menu-bar";
import { withTodoistApi } from "./helpers/withTodoistApi";

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
  let locked = false;
  let completed = false;
  let warning: string | undefined;
  const cache = new Cache();
  const readSession = async () => JSON.parse(await readFile(join(directory, "state.json"), "utf8")).session;
  async function result(success: boolean, error?: string) {
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ sessionId, success, error }), { mode: 0o600 });
    await rename(temporary, join(directory, "completion.json"));
  }
  try {
    const session = await readSession();
    if (session?.id !== sessionId || session.task?.id !== taskId || session.phase === "ended") return;
    try {
      await mkdir(lock);
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    let data = (await initialSync()) as SyncData;
    const state = {
      data,
      setData: (value: React.SetStateAction<SyncData | undefined>) => {
        data = (typeof value === "function" ? value(data) : value) as SyncData;
        cache.set("data", JSON.stringify(data));
      },
    };
    // Reusing the session UUID makes retries safe for recurring tasks, including uncertain network outcomes.
    await closeTask(taskId, state, sessionId);
    completed = true;
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
          warning = "Oppgaven er fullført, men fokusetiketten kunne ikke fjernes.";
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
    if (locked) await rm(lock, { recursive: true, force: true });
  }
}

export default withTodoistApi(completeFocusedTask);
