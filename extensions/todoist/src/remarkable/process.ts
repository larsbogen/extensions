import { spawn } from "node:child_process";

export type ProcessResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { env?: NodeJS.ProcessEnv; timeoutMs?: number };
export type Runner = (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;

/** Never invoke a shell or print child output (it may contain account information). */
export const runProcess: Runner = (executable, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Prosessen brukte for lang tid og ble stoppet."), options.timeoutMs ?? 90_000);
    child.on("error", () => fail("Kunne ikke starte verktøyet. Kontroller sti og kjørerettigheter."));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 8_000_000) fail("Verktøyet returnerte for mye data.");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) fail("Verktøyet returnerte for mye feildata.");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
