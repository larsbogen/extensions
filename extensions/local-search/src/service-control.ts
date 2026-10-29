/* eslint-disable no-control-regex -- Strip terminal controls from literal log output. */
import { execFile } from "node:child_process";
import { access, open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { configuration, type Settings } from "./settings";
import { localUrl } from "./service";
export type ServiceKind = "library" | "atlas";
export type Status = {
  version: 1;
  service: ServiceKind;
  state: "ready" | "stopped" | "transitioning" | "unknown";
  url: string | null;
  logPath: string;
  canStop: boolean;
  message?: string;
};
export const names = { library: "Masteroppgaver", atlas: "Turatlas" };
export function parseStatus(raw: string, kind: ServiceKind): Status {
  let s: Status;
  try {
    s = JSON.parse(raw);
  } catch {
    throw new Error(
      "Kontrollskriptet må oppdateres med støtte for status --json.",
    );
  }
  if (
    !s ||
    s.version !== 1 ||
    s.service !== kind ||
    !["ready", "stopped", "transitioning", "unknown"].includes(s.state) ||
    typeof s.canStop !== "boolean" ||
    typeof s.logPath !== "string" ||
    !isAbsolute(s.logPath) ||
    (s.message !== undefined && typeof s.message !== "string") ||
    (s.state !== "ready" && (s.url !== null || s.canStop))
  )
    throw new Error("Ugyldig status fra kontrollskriptet.");
  if (s.state === "ready") {
    if (typeof s.url !== "string")
      throw new Error("Mangler bekreftet serveradresse.");
    s.url = localUrl(s.url);
  }
  return s;
}
export function execute(
  binary: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { cwd, timeout, maxBuffer: 65536 },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              error.killed
                ? "Tidsgrensen er nådd. Status kontrolleres; handlingen gjentas ikke automatisk."
                : "Kontrollkommandoen mislyktes. Se loggen og kontroller at kontrollskriptet er oppdatert.",
            ),
          );
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end();
  });
}
export class ServiceControl {
  private busy = new Set<ServiceKind>();
  constructor(private settings: Settings) {}
  async status(kind: ServiceKind): Promise<Status> {
    const c = configuration(this.settings, kind);
    const fallback: Status = {
      version: 1,
      service: kind,
      state: "unknown",
      url: null,
      logPath: join(
        c.root,
        kind === "library" ? "state/server.log" : "data/launcher/server.log",
      ),
      canStop: false,
    };
    try {
      try {
        await access(c.root);
      } catch {
        throw new Error(`Finner ikke prosjektmappen: ${c.root}`);
      }
      try {
        await access(c.binary, constants.X_OK);
      } catch {
        throw new Error(`Finner ikke kjøretiden: ${c.binary}`);
      }
      try {
        await access(join(c.root, c.script));
      } catch {
        throw new Error(
          "Finner ikke tjenestens kontrollskript i prosjektmappen.",
        );
      }
      return parseStatus(
        await execute(c.binary, [...c.args, "status", "--json"], c.root, 20000),
        kind,
      );
    } catch (error) {
      return {
        ...fallback,
        message:
          error instanceof Error
            ? error.message
            : "Kunne ikke kontrollere status.",
      };
    }
  }
  async perform(
    kind: ServiceKind,
    action: "open" | "start" | "stop",
    openBrowser: (url: string) => Promise<unknown>,
    alsoOpen = false,
  ): Promise<{ status: Status; error?: string }> {
    if (this.busy.has(kind)) throw new Error("En handling pågår allerede.");
    this.busy.add(kind);
    let status: Status | undefined;
    try {
      status = await this.status(kind);
      if (action === "open") {
        if (status.state !== "ready" || !status.url)
          throw new Error("Tjenesten er ikke bekreftet klar. Oppdater status.");
      } else {
        if (action === "stop" && (status.state !== "ready" || !status.canStop))
          throw new Error(
            status.message || "Kontrollert stopp er ikke tilgjengelig.",
          );
        if (action === "start" && !["ready", "stopped"].includes(status.state))
          throw new Error(status.message || "Status må avklares før oppstart.");
        if (!(action === "start" && status.state === "ready")) {
          const c = configuration(this.settings, kind);
          try {
            await execute(
              c.binary,
              [...c.args, action, ...(action === "start" ? ["--no-open"] : [])],
              c.root,
              90000,
            );
          } catch (error) {
            status = await this.status(kind);
            return { status, error: (error as Error).message };
          }
          status = await this.status(kind);
          if (status.state !== (action === "start" ? "ready" : "stopped"))
            throw new Error(
              status.message ||
                "Handlingen er ikke bekreftet ferdig. Oppdater status.",
            );
        }
      }
      if ((action === "open" || alsoOpen) && status.url)
        await openBrowser(status.url);
      return { status };
    } catch (error) {
      return {
        status: status || (await this.status(kind)),
        error: (error as Error).message,
      };
    } finally {
      this.busy.delete(kind);
    }
  }
}
export async function readLog(file: string): Promise<string> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Loggstien er ikke en vanlig fil.");
    const size = Math.min(info.size, 65536);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      size,
      Math.max(0, info.size - size),
    );
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (info.size > size)
      text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return text
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .trimEnd()
      .split("\n")
      .slice(-200)
      .join("\n");
  } finally {
    await handle.close();
  }
}
export function literalLog(text: string): string {
  const fence = "`".repeat(
    Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)),
  );
  return `${fence}text\n${text}\n${fence}`;
}
