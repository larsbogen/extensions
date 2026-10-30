import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkday, type WorkdayPlan } from "./model";

function validateKey(accountId: string, day: string) {
  if (!accountId || !/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day)
    throw new Error("Ugyldig konto eller dato for arbeidsdagen.");
}

export function validateWorkday(value: unknown, accountId: string, day: string): WorkdayPlan {
  const plan = value as WorkdayPlan;
  if (
    !plan ||
    plan.version !== 1 ||
    plan.accountId !== accountId ||
    plan.day !== day ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 0 ||
    !Array.isArray(plan.entries) ||
    !Array.isArray(plan.topThree)
  )
    throw new Error("Arbeidsdagen kunne ikke leses. Den lagrede filen er beholdt.");
  const ids = new Set<string>();
  const activeTasks = new Set<string>();
  for (const entry of plan.entries) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id ||
      ids.has(entry.id) ||
      typeof entry.taskId !== "string" ||
      !entry.taskId ||
      (entry.occurrence !== null && typeof entry.occurrence !== "string") ||
      !["active", "completed", "unavailable", "removed"].includes(entry.status) ||
      typeof entry.addedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.addedAt)) ||
      ![entry.title, entry.projectId, entry.projectName].every((field) => typeof field === "string") ||
      (entry.status === "active" && activeTasks.has(entry.taskId))
    )
      throw new Error("Arbeidsdagen inneholder ugyldige oppføringer.");
    ids.add(entry.id);
    if (entry.status === "active") activeTasks.add(entry.taskId);
  }
  if (
    plan.topThree.length > 3 ||
    new Set(plan.topThree).size !== plan.topThree.length ||
    plan.topThree.some((id) => !ids.has(id))
  )
    throw new Error("Arbeidsdagens fokusmarkeringer er ugyldige.");
  return plan;
}

export class WorkdayStore {
  constructor(
    readonly directory: string,
    private timeoutMs = 5000,
  ) {}

  private accountDirectory(accountId: string) {
    return join(this.directory, createHash("sha256").update(accountId).digest("hex"));
  }

  async read(accountId: string, day: string): Promise<WorkdayPlan | undefined> {
    validateKey(accountId, day);
    try {
      return validateWorkday(
        JSON.parse(await readFile(join(this.accountDirectory(accountId), `${day}.json`), "utf8")),
        accountId,
        day,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async latestPrevious(accountId: string, day: string): Promise<WorkdayPlan | undefined> {
    validateKey(accountId, day);
    let files: string[];
    try {
      files = await readdir(this.accountDirectory(accountId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const previous = files
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file) && file.slice(0, 10) < day)
      .sort()
      .slice(-1)[0];
    return previous ? this.read(accountId, previous.slice(0, 10)) : undefined;
  }

  async update(accountId: string, day: string, mutate: (plan: WorkdayPlan) => WorkdayPlan): Promise<WorkdayPlan> {
    validateKey(accountId, day);
    const directory = this.accountDirectory(accountId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let lock = join(directory, `${day}.lock`);
    let generation = 0;
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // Never delete a dead owner's lock: all contenders compete for the same
      // recovery child instead. This avoids a stale reaper deleting a new owner.
      let abandoned = false;
      try {
        const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            abandoned = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try {
            abandoned = Date.now() - (await stat(lock)).mtimeMs > 60000;
          } catch {
            /* The owner already released its lock. */
          }
        }
      }
      if (abandoned) {
        if (++generation > 32) throw new Error("Arbeidsdagens lås har for mange avbrutte oppdateringer.");
        lock = join(lock, "recovery");
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Arbeidsdagen oppdateres av en annen kommando. Prøv igjen.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const temporary = join(directory, `${day}-${randomUUID()}.tmp`);
    try {
      await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      const previous = await this.read(accountId, day);
      const base = previous ?? createWorkday(accountId, day);
      const next = validateWorkday(mutate(structuredClone(base)), accountId, day);
      if (previous && JSON.stringify(next) === JSON.stringify(previous)) return previous;
      next.revision = base.revision + 1;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, join(directory, `${day}.json`));
      return next;
    } finally {
      await rm(temporary, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
