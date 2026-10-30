import { Cache, environment, LaunchProps, showHUD } from "@raycast/api";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { initialSync, SyncData } from "./api";
import { assertFocusTransition, startFocusedTask } from "./focus/service";
import type { FocusQueueContext } from "./focus/panel";
import { withTodoistApi } from "./helpers/withTodoistApi";
import { markCompleted, nextEntry, reconcilePlan } from "./workday/model";
import { getWorkdayStore } from "./workday/runtime";
import { acquireFocusLock, writeFocusJson } from "./focus/storage";

export type NextFocusContext = { sessionId?: string; requestId?: string };
const uuid = /^[0-9a-f-]{36}$/i;

export async function nextFocusTask({ launchContext }: LaunchProps<{ launchContext: NextFocusContext }>) {
  const { sessionId, requestId } = launchContext ?? {};
  if (!sessionId || !requestId || !uuid.test(sessionId) || !uuid.test(requestId)) {
    await showHUD("Bruk Neste oppgave i fokusvinduet.");
    return;
  }
  const guard = { sessionId, requestId };
  const directory = join(environment.supportPath, "focus-panel");
  const lock = join(directory, `next-${requestId}.lock`);
  let release: (() => Promise<void>) | undefined;
  async function result(success: boolean, empty = false, error?: string) {
    await assertFocusTransition(guard);
    await writeFocusJson(join(directory, "next.json"), { sessionId, requestId, success, empty, error });
  }
  try {
    await assertFocusTransition(guard);
    release = await acquireFocusLock(lock);
    if (!release) return;
    const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    const queue: FocusQueueContext | undefined = saved.session?.task?.queue;
    if (!queue) throw new Error("Fokusøkten er ikke knyttet til en arbeidsdag.");
    const observedAt = new Date().toISOString();
    let data = (await initialSync()) as SyncData;
    if (data.user?.id !== queue.accountId) throw new Error("Arbeidsdagen tilhører en annen Todoist-konto.");
    await assertFocusTransition(guard);
    const store = getWorkdayStore();
    if (!(await store.read(queue.accountId, queue.day))) throw new Error("Arbeidsdagen finnes ikke lenger.");
    const plan = await store.update(queue.accountId, queue.day, (plan) => {
      const completed = saved.session.queueCompleted ? markCompleted(plan, queue.entryId) : plan;
      return reconcilePlan(completed, data.items, data.projects, data.user.id, [], observedAt);
    });
    const entry = nextEntry(plan, queue.entryId);
    if (!entry) {
      await result(true, true);
      return;
    }
    const task = data.items.find((task) => task.id === entry.taskId);
    if (!task) throw new Error("Neste oppgave er ikke tilgjengelig. Oppdater arbeidsdagen.");
    const cache = new Cache();
    await startFocusedTask(
      task,
      {
        data,
        setData: (value) => {
          data = (typeof value === "function" ? value(data) : value) as SyncData;
          cache.set("data", JSON.stringify(data));
        },
      },
      { ...queue, entryId: entry.id, revision: plan.revision },
      guard,
    );
    // Acknowledgement of the guarded native start is the success receipt. A
    // next.json response belongs to the old session and must not change the new one.
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kunne ikke hente neste oppgave. Prøv igjen.";
    await result(false, false, message).catch(() => undefined);
    await showHUD(message);
  } finally {
    if (release) await release();
  }
}

export default withTodoistApi(nextFocusTask);
