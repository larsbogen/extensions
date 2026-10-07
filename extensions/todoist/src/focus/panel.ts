import { environment } from "@raycast/api";
import { createDeeplink } from "@raycast/utils";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import removeMarkdown from "remove-markdown";

type FocusTask = { id: string; content: string; projectId?: string };
type PanelRequest = {
  id: string;
  action: "start" | "stop" | "show";
  task?: { id: string; title: string; url: string; completionURL?: string; projectId?: string };
  taskId?: string;
  sessionId?: string;
  duration?: number;
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
            return;
          }
          // Completing a task can unfocus it from both the task view and the
          // menu bar. Either stop acknowledgement is sufficient for that task.
          if (
            request.action === "stop" &&
            state.session &&
            (state.session.phase === "ended" || (request.taskId && state.session.task?.id !== request.taskId))
          ) {
            return;
          }
        } catch {
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
      throw new Error("Fokusvinduet svarte ikke. Prøv «Show Focus Window» på nytt.");
    });
    pending = operation.catch(() => undefined);
    return operation;
  }

  return {
    start(task: FocusTask, minutes: number) {
      if (!task.id || !task.content.trim()) return Promise.reject(new Error("Ingen fokusoppgave er valgt."));
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
        return Promise.reject(new Error("Øktlengden må være mellom 0 og 1440 minutter."));
      }
      return send({
        id: randomUUID(),
        action: "start",
        task: {
          id: task.id,
          title: removeMarkdown(task.content),
          url: `https://todoist.com/app/task/${encodeURIComponent(task.id)}`,
          completionURL: createDeeplink({ command: "complete-focused-task" }),
          projectId: task.projectId,
        },
        duration: minutes * 60,
      });
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
      if (!state.session || (!pending && !state.tracking?.takeover)) return false;
      await send({ id: randomUUID(), action: "show" });
      return true;
    },
    async stop(taskId?: string) {
      // No session file means the helper has never run; unfocusing still works.
      let sessionId: string | undefined;
      try {
        const state = JSON.parse(await readFile(join(options.directory, "state.json"), "utf8"));
        sessionId = state.session?.id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await send({ id: randomUUID(), action: "stop", taskId, sessionId });
    },
  };
}

const client = createFocusPanelClient({
  directory: join(environment.supportPath, "focus-panel"),
  executable: join(environment.assetsPath, "focus-panel", "FocusPanel.app", "Contents", "MacOS", "FocusPanel"),
});

export async function showFocusPanel(task: FocusTask, minutes = 25) {
  if (process.platform !== "darwin") throw new Error("Det flytende fokusvinduet krever macOS.");
  await client.start(task, minutes);
}

export async function stopFocusPanel(taskId?: string) {
  if (process.platform === "darwin") await client.stop(taskId);
}

export async function showPendingFocusPanel() {
  return process.platform === "darwin" ? client.showPending() : false;
}
