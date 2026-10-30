import { environment } from "@raycast/api";
import { createDeeplink } from "@raycast/utils";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import removeMarkdown from "remove-markdown";

export type FocusQueueContext = { accountId: string; day: string; entryId: string; revision: number };
export type FocusTransitionGuard = { sessionId: string; requestId: string };
export type FocusTask = {
  id: string;
  content: string;
  projectId?: string;
  projectName?: string;
  todoistUserId?: string;
  queue?: FocusQueueContext;
};
type PanelRequest = {
  id: string;
  action: "start" | "start-queue" | "stop" | "show";
  task?: {
    id: string;
    title: string;
    url: string;
    completionURL?: string;
    projectId?: string;
    projectName?: string;
    todoistUserId?: string;
    queue?: FocusQueueContext;
    nextURL?: string;
  };
  taskId?: string;
  sessionId?: string;
  duration?: number;
  transitionRequestId?: string;
  expiresAt?: number;
  automatic?: boolean;
};

async function launch(executable: string, directory: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [directory], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

// File IPC keeps task titles out of shell interpolation and credentials out of the helper.
// The native process takes an exclusive lock, so repeated launches share one panel.
export function createFocusPanelClient(options: {
  directory: string;
  executable: string;
  launch?: typeof launch;
  timeoutMs?: number;
}) {
  let pending = Promise.resolve();

  function send(request: PanelRequest) {
    const operation = pending.then(async () => {
      try {
        await access(options.executable);
      } catch {
        throw new Error("Fokusvinduet er ikke bygget. Kjør npm run build:focus i Todoist-prosjektet.");
      }
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      // A separate file per command prevents concurrent Raycast processes from
      // overwriting one another's requests. The helper consumes them in order.
      const inbox = join(options.directory, "requests");
      await mkdir(inbox, { recursive: true, mode: 0o700 });
      const temporary = join(inbox, `${request.id}.tmp`);
      const queued = join(inbox, `${Date.now()}-${request.id}.json`);
      if (request.action === "start-queue") request.expiresAt = (Date.now() + (options.timeoutMs ?? 6000)) / 1000;
      await writeFile(temporary, JSON.stringify(request), { mode: 0o600 });
      await rename(temporary, queued);
      await (options.launch ?? launch)(options.executable, options.directory);
      const deadline = Date.now() + (options.timeoutMs ?? 6000);
      let lastLaunch = Date.now();
      while (Date.now() < deadline) {
        try {
          const state = JSON.parse(await readFile(join(options.directory, "state.json"), "utf8"));
          if (state.requestId === request.id || state.acknowledgedRequests?.includes(request.id)) {
            await rm(queued, { force: true });
            if (request.action === "start-queue" && state.session?.originRequestId !== request.id) {
              throw Object.assign(new Error("Fokusøkten er endret. Åpne arbeidsdagen for å fortsette."), {
                staleFocus: true,
              });
            }
            if (request.automatic)
              return (
                state.session?.id === request.sessionId &&
                state.session?.phase === "ended" &&
                !state.session?.task?.queue
              );
            return;
          }
          // Completing a task can unfocus it from both the task view and the
          // menu bar. Either stop acknowledgement is sufficient for that task.
          if (
            request.action === "stop" &&
            !request.automatic &&
            state.session &&
            (state.session.phase === "ended" || (request.taskId && state.session.task?.id !== request.taskId))
          ) {
            return;
          }
        } catch (error) {
          if ((error as { staleFocus?: boolean }).staleFocus) throw error;
          // Startup and atomic replacement may briefly leave no readable state.
        }
        // A previous helper can still hold the process lock briefly after its
        // stop acknowledgement. Retrying cannot create duplicate panels.
        if (Date.now() - lastLaunch >= 1000) {
          await (options.launch ?? launch)(options.executable, options.directory);
          lastLaunch = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // An old helper cannot consume start-queue. Do not leave an unsupported
      // command blocking its inbox, or replay an abandoned queue start later.
      if (request.action === "start-queue") await rm(queued, { force: true });
      throw new Error("Fokusvinduet svarte ikke. Prøv «Show Focus Window» på nytt.");
    });
    pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  return {
    start(task: FocusTask, minutes: number, guard?: FocusTransitionGuard) {
      if (!task.id || !task.content.trim()) return Promise.reject(new Error("Ingen fokusoppgave er valgt."));
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
        return Promise.reject(new Error("Øktlengden må være mellom 0 og 1440 minutter."));
      }
      return send({
        id: randomUUID(),
        action: task.queue ? "start-queue" : "start",
        sessionId: guard?.sessionId,
        transitionRequestId: guard?.requestId,
        task: {
          id: task.id,
          title: removeMarkdown(task.content),
          url: `https://todoist.com/app/task/${encodeURIComponent(task.id)}`,
          completionURL: createDeeplink({ command: "complete-focused-task" }),
          projectId: task.projectId,
          projectName: task.projectName,
          todoistUserId: task.todoistUserId,
          queue: task.queue,
          nextURL: task.queue ? createDeeplink({ command: "next-focus-task" }) : undefined,
        },
        duration: minutes * 60,
      });
    },
    async showExisting(taskId: string) {
      let state;
      try {
        state = JSON.parse(await readFile(join(options.directory, "state.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      if (state.session?.task?.id !== taskId || (state.session.phase === "ended" && !state.session.task.queue))
        return false;
      await send({ id: randomUUID(), action: "show" });
      return true;
    },
    async showPending() {
      let state;
      try {
        state = JSON.parse(await readFile(join(options.directory, "state.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      const pending = state.tracking?.periods?.some(
        (period: { sync: string; recoveryDetectedAt?: number }) =>
          !["local", "synced", "accepted"].includes(period.sync) || period.recoveryDetectedAt != null,
      );
      if (!state.session || (!pending && !state.tracking?.takeover && !state.session.task?.queue)) return false;
      await send({ id: randomUUID(), action: "show" });
      return true;
    },
    async stop(taskId?: string, automatic = false) {
      // No session file means the helper has never run; unfocusing still works.
      let sessionId: string | undefined;
      try {
        const state = JSON.parse(await readFile(join(options.directory, "state.json"), "utf8"));
        sessionId = state.session?.id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      return send({ id: randomUUID(), action: "stop", taskId, sessionId, automatic });
    },
  };
}

const client = createFocusPanelClient({
  directory: join(environment.supportPath, "focus-panel"),
  executable: join(environment.assetsPath, "focus-panel", "FocusPanel.app", "Contents", "MacOS", "FocusPanel"),
});

async function recordFocusLocation() {
  const root = join(homedir(), "Library/Application Support/PersonalRaycast");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "focus-location.json"),
    JSON.stringify({ directory: join(environment.supportPath, "focus-panel") }),
    { mode: 0o600 },
  );
}
export async function showFocusPanel(task: FocusTask, minutes = 25, guard?: FocusTransitionGuard) {
  if (process.platform !== "darwin") throw new Error("Det flytende fokusvinduet krever macOS.");
  await recordFocusLocation();
  await client.start(task, minutes, guard);
}

export async function stopFocusPanel(taskId?: string, automatic = false) {
  if (process.platform === "darwin") return client.stop(taskId, automatic);
}

export async function showPendingFocusPanel() {
  return process.platform === "darwin" ? client.showPending() : false;
}

export async function showExistingFocusPanel(taskId: string) {
  return process.platform === "darwin" ? client.showExisting(taskId) : false;
}
