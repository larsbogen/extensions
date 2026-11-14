import { Cache, environment, LaunchProps, showHUD } from "@raycast/api";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { initialSync, SyncData } from "./api";
import { showExistingFocusPanel } from "./focus/panel";
import { readFocusedTask, startFocusedTask } from "./focus/service";
import { acquireFocusLock, writeFocusJson } from "./focus/storage";
import { refreshMenuBarCommand } from "./helpers/menu-bar";
import { withTodoistApi } from "./helpers/withTodoistApi";

export type FocusTaskContext = { taskId?: string; accountId?: string; requestId?: string; issuedAt?: string };
export type FocusTaskReceipt = {
  version: 1;
  requestId: string;
  taskId: string;
  accountId?: string;
  issuedAt: string;
  updatedAt: string;
  status: "pending" | "started" | "failed" | "unknown";
  error?: string;
};

const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maximumAgeMs = 5 * 60 * 1000;

function parseContext(value: FocusTaskContext | undefined) {
  const { taskId, accountId, requestId, issuedAt } = value ?? {};
  if (typeof taskId !== "string" || !identifier.test(taskId)) throw new Error("Start fokus fra en Todoist-oppgave.");
  if (accountId !== undefined && (typeof accountId !== "string" || !identifier.test(accountId)))
    throw new Error("Todoist-kontoen er ugyldig.");
  if (
    (requestId !== undefined || issuedAt !== undefined) &&
    (typeof requestId !== "string" ||
      !uuid.test(requestId) ||
      typeof issuedAt !== "string" ||
      !Number.isFinite(Date.parse(issuedAt)) ||
      new Date(issuedAt).toISOString() !== issuedAt)
  )
    throw new Error("Fokusforespørselen er ugyldig. Velg Start fokus i Todoist på nytt.");
  return { taskId, accountId, requestId, issuedAt };
}

function assertFresh(issuedAt?: string) {
  if (!issuedAt) return;
  const age = Date.now() - Date.parse(issuedAt);
  if (age < -30000 || age > maximumAgeMs)
    throw new Error("Fokusforespørselen er utløpt. Velg Start fokus i Todoist på nytt.");
}

/** Starts the selected official Todoist task without trusting task text from a URL. */
export async function focusTask({ launchContext }: LaunchProps<{ launchContext: FocusTaskContext }>) {
  let context: ReturnType<typeof parseContext>;
  try {
    context = parseContext(launchContext);
  } catch (error) {
    await showHUD((error as Error).message);
    return;
  }
  const { taskId, accountId, requestId, issuedAt } = context;
  const directory = join(environment.supportPath, "focus-requests");
  const receiptFile = requestId ? join(directory, `${requestId}.json`) : undefined;
  let release: (() => Promise<void>) | undefined;
  let effectStarted = false;
  let receiptExists = false;
  async function receipt(status: FocusTaskReceipt["status"], error?: string) {
    if (receiptFile && requestId && issuedAt) {
      await writeFocusJson(receiptFile, {
        version: 1,
        requestId,
        taskId,
        accountId,
        issuedAt,
        updatedAt: new Date().toISOString(),
        status,
        ...(error ? { error } : {}),
      } satisfies FocusTaskReceipt);
    }
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // The lock covers distinct external requests as well as duplicate launches.
    release = await acquireFocusLock(join(directory, "start.lock"));
    if (receiptFile) {
      try {
        const contents = await readFile(receiptFile, "utf8");
        receiptExists = true;
        const saved = JSON.parse(contents) as FocusTaskReceipt;
        if (saved.taskId !== taskId || saved.accountId !== accountId || saved.issuedAt !== issuedAt)
          throw new Error("Fokusforespørselen er allerede brukt til en annen oppgave.");
        // A pending receipt may have crossed the native boundary before a crash.
        // Do not reset a timer, or resurrect an old task, by retrying it.
        if (saved.status !== "started")
          await showHUD(saved.error ?? "Fokusforespørselen er allerede sendt. Se fokusvinduet.");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!release) {
      // Another process may own this same request and not have written its
      // receipt yet. Never overwrite that outcome with a spurious busy failure.
      await showHUD("En annen fokusforespørsel behandles. Velg Start fokus på nytt om litt.");
      return;
    }
    assertFresh(issuedAt);
    const previous = JSON.stringify(readFocusedTask());
    let data = (await initialSync()) as SyncData;
    if (accountId && data.user?.id !== accountId)
      throw new Error("Oppgaven tilhører en annen Todoist-konto enn den som er koblet til Raycast.");
    const task = data.items.find((item) => item.id === taskId);
    const project = data.projects.find((item) => item.id === task?.project_id);
    if (!task || task.checked || task.is_deleted || task.completed_at)
      throw new Error("Oppgaven er fullført, slettet eller ikke tilgjengelig. Oppdater Todoist.");
    if (!project || project.is_deleted || project.is_archived)
      throw new Error("Oppgavens prosjekt er arkivert eller ikke tilgjengelig.");
    assertFresh(issuedAt);
    if (JSON.stringify(readFocusedTask()) !== previous)
      throw new Error("Fokusoppgaven ble endret mens Todoist ble hentet. Velg Start fokus på nytt.");
    await receipt("pending");
    effectStarted = true;
    // Reopening the same task must preserve elapsed time, pause state and queue.
    const existing = readFocusedTask().id === taskId && (await showExistingFocusPanel(taskId));
    if (!existing) {
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
        undefined,
        undefined,
        { forcePanel: true },
      );
    }
    await receipt("started");
    await refreshMenuBarCommand().catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kunne ikke starte fokus for oppgaven.";
    if (!receiptExists) await receipt(effectStarted ? "unknown" : "failed", message).catch(() => undefined);
    await showHUD(message);
  } finally {
    await release?.();
  }
}

export default withTodoistApi(focusTask);
