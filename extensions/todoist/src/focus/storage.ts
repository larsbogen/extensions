import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Crash-safe receipt: a partial write can never look like a committed intent. */
export async function writeFocusJson(file: string, value: unknown): Promise<void> {
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Suppress overlap, but allow a retry after the command process has died. */
export async function acquireFocusLock(path: string): Promise<(() => Promise<void>) | undefined> {
  let lock = path;
  for (let generation = 0; generation < 32; generation++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        await writeFocusJson(join(lock, "owner.json"), { pid: process.pid });
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      const owned = lock;
      return () => rm(owned, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
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
    } catch {
      try {
        abandoned = Date.now() - (await stat(lock)).mtimeMs > 60000;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          generation--;
          continue;
        }
        throw error;
      }
    }
    if (!abandoned) return;
    // Do not remove a dead owner's parent: competing retries all claim the same
    // child, so one retry cannot accidentally delete another retry's new lock.
    lock = join(lock, "recovery");
  }
  throw new Error("Fokuskommandoen har for mange avbrutte forsøk. Prøv en ny fokusøkt.");
}
