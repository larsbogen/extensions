import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { VM, VMAction, VMState } from "./types";

export const PRLCTL = "/usr/local/bin/prlctl";
export const PRLSRVCTL = "/usr/local/bin/prlsrvctl";
export const PARALLELS_BUNDLE_ID = "com.parallels.desktop.console";
export const READ_TIMEOUT = 30_000;
export const CHANGE_TIMEOUT = 120_000;
export const POLL_INTERVAL = 2_000;

type ErrorCode =
  | "selection"
  | "invalid-data"
  | "unavailable"
  | "cli-missing"
  | "license"
  | "timeout"
  | "command"
  | "state"
  | "opening";

export class ParallelsError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ParallelsError";
  }
}

export type Runner = (file: string, args: string[], timeout: number) => Promise<string>;

// Ending stdin also prevents an unattended CLI prompt from waiting indefinitely.
export const execCommand: Runner = (file, args, timeout) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.end();
  });

function commandError(error: unknown, file: string): ParallelsError {
  if (error instanceof ParallelsError) return error;
  const details = error as { code?: string; killed?: boolean; stderr?: string; message?: string } | null;
  const message = (details?.stderr?.trim() || details?.message || String(error)).slice(0, 1200);
  if (details?.code === "ENOENT") {
    return new ParallelsError(
      "cli-missing",
      `Cannot find ${file}. Install or repair the Parallels command-line tools.`,
      { cause: error },
    );
  }
  if (details?.killed || details?.code === "ETIMEDOUT") {
    return new ParallelsError(
      "timeout",
      "Parallels did not respond before the time limit. The command was not repeated.",
      { cause: error },
    );
  }
  if (/licen[cs]e|only.*(?:pro|business|enterprise).*edition|(?:pro|business).*edition.*only/i.test(message)) {
    return new ParallelsError(
      "license",
      `Parallels requires an edition with command-line support (Pro, Business or Enterprise). ${message}`,
      { cause: error },
    );
  }
  return new ParallelsError("command", `Parallels command failed: ${message}`, { cause: error });
}

export function stateFromText(text: string): VMState {
  if (text === "inaccessible" || text === "invalid") return VMState.Unavailable;
  return Object.values(VMState).includes(text as VMState) ? (text as VMState) : VMState.Unknown;
}

export function parseVMs(output: string): VM[] {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch (cause) {
    throw new ParallelsError("invalid-data", "Parallels returned invalid JSON. Refresh the list and try again.", {
      cause,
    });
  }
  if (!Array.isArray(data)) throw new ParallelsError("invalid-data", "Parallels returned an invalid VM list.");
  const ids = new Set<string>();
  return data.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ParallelsError("invalid-data", "Parallels returned an invalid VM entry.");
    }
    const row = entry as Record<string, unknown>;
    for (const key of ["ID", "Name", "State"]) {
      if (typeof row[key] !== "string" || !row[key].trim()) {
        throw new ParallelsError("invalid-data", `A Parallels VM is missing a valid ${key} field.`);
      }
    }
    const id = normalizeID(row.ID as string);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new ParallelsError("invalid-data", "Parallels returned an invalid VM identifier.");
    }
    if (ids.has(id)) throw new ParallelsError("invalid-data", "Parallels returned duplicate VM identifiers.");
    ids.add(id);
    const rawState = row.State as string;
    return {
      id,
      name: row.Name as string,
      rawState,
      state: stateFromText(rawState),
      home: typeof row.Home === "string" && row.Home ? row.Home : undefined,
      os: typeof row.OS === "string" ? row.OS : "",
      description: typeof row.Description === "string" ? row.Description : "",
    };
  });
}

function normalizeID(value: string): string {
  return value
    .trim()
    .replace(/^\{(.*)\}$/, "$1")
    .toLowerCase();
}

export function findVM(vms: VM[], identifier: string): VM {
  const query = identifier.trim();
  const matches = query ? vms.filter((vm) => vm.id === normalizeID(query) || vm.name === query) : [];
  if (matches.length !== 1) {
    throw new ParallelsError(
      "selection",
      matches.length
        ? `More than one VM is named “${query}”. Set its UUID in this command's settings.`
        : `No VM matches “${query}”. Set the exact VM name or UUID in this command's settings.`,
    );
  }
  return matches[0];
}

interface Dependencies {
  openFile: (path: string) => Promise<void>;
  run?: Runner;
  exists?: (path: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class ParallelsService {
  private readonly run: Runner;
  private readonly exists: (path: string) => Promise<void>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly dependencies: Dependencies) {
    this.run = dependencies.run ?? execCommand;
    this.exists = dependencies.exists ?? access;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async cli(file: string, args: string[], timeout: number): Promise<string> {
    try {
      return await this.run(file, args, timeout);
    } catch (error) {
      throw commandError(error, file);
    }
  }

  async listVMs(timeout = READ_TIMEOUT): Promise<VM[]> {
    return parseVMs(await this.cli(PRLCTL, ["list", "--all", "--full", "--json", "--info"], timeout));
  }

  private async getVM(id: string, timeout = READ_TIMEOUT): Promise<VM> {
    const vm = (await this.listVMs(timeout)).find((candidate) => candidate.id === id);
    if (!vm) throw new ParallelsError("unavailable", "The selected VM is no longer registered in Parallels.");
    return vm;
  }

  private async checkHome(vm: VM): Promise<string> {
    if (!vm.home || !isAbsolute(vm.home)) {
      throw new ParallelsError("unavailable", `“${vm.name}” has no valid VM file path in Parallels.`);
    }
    try {
      await this.exists(vm.home);
    } catch (cause) {
      throw new ParallelsError(
        "unavailable",
        `The VM file for “${vm.name}” is missing or inaccessible. Check it in Parallels.`,
        { cause },
      );
    }
    return vm.home;
  }

  private timeoutError(vm: VM, target: VMState): ParallelsError {
    return new ParallelsError(
      "timeout",
      `“${vm.name}” did not reach ${target} before the time limit. Current status: ${vm.rawState}. The command was not repeated; refresh before trying again.`,
    );
  }

  private async reconcile(id: string, target: VMState): Promise<VM> {
    let vm: VM;
    try {
      vm = await this.getVM(id);
    } catch (cause) {
      throw new ParallelsError(
        "timeout",
        "Parallels timed out and its current status could not be read. The result is uncertain. Check Parallels before trying again.",
        { cause },
      );
    }
    if (vm.state === target) return vm;
    throw this.timeoutError(vm, target);
  }

  private async waitFor(
    id: string,
    target: VMState,
    deadline: number,
    progress?: (message: string) => void,
  ): Promise<VM> {
    while (this.now() < deadline) {
      let vm: VM;
      try {
        vm = await this.getVM(id, Math.min(READ_TIMEOUT, Math.max(1, deadline - this.now())));
      } catch (error) {
        if (error instanceof ParallelsError && error.code === "timeout") return this.reconcile(id, target);
        throw error;
      }
      if (vm.state === target) return vm;
      if (
        vm.state === VMState.Unknown ||
        vm.state === VMState.Unavailable ||
        (target === VMState.Running && [VMState.Stopping, VMState.Suspending, VMState.Pausing].includes(vm.state))
      ) {
        throw new ParallelsError(
          "state",
          `“${vm.name}” is ${vm.rawState}. Check the VM in Parallels before trying again.`,
        );
      }
      progress?.(`Waiting for ${vm.name} (${vm.rawState})…`);
      await this.sleep(Math.min(POLL_INTERVAL, Math.max(0, deadline - this.now())));
    }
    return this.reconcile(id, target);
  }

  private async change(vm: VM, args: string[], target: VMState, progress?: (message: string) => void): Promise<VM> {
    const deadline = this.now() + CHANGE_TIMEOUT;
    try {
      await this.cli(PRLCTL, args, CHANGE_TIMEOUT);
    } catch (error) {
      if (error instanceof ParallelsError && error.code === "timeout") return this.reconcile(vm.id, target);
      throw error;
    }
    return this.waitFor(vm.id, target, deadline, progress);
  }

  async openVM(identifier: string, progress?: (message: string) => void): Promise<VM> {
    let vm = findVM(await this.listVMs(), identifier);
    await this.checkHome(vm);
    switch (vm.state) {
      case VMState.Stopped:
        progress?.(`Starting ${vm.name}…`);
        vm = await this.change(vm, ["start", vm.id], VMState.Running, progress);
        break;
      case VMState.Suspended:
      case VMState.Paused:
        progress?.(`Resuming ${vm.name}…`);
        vm = await this.change(vm, ["resume", vm.id], VMState.Running, progress);
        break;
      case VMState.Starting:
      case VMState.Resuming:
        vm = await this.waitFor(vm.id, VMState.Running, this.now() + CHANGE_TIMEOUT, progress);
        break;
      case VMState.Running:
        break;
      default:
        throw new ParallelsError(
          "state",
          `“${vm.name}” is ${vm.rawState}. Wait for it to finish or check it in Parallels.`,
        );
    }
    const home = await this.checkHome(vm);
    progress?.(`Opening ${vm.name}…`);
    try {
      await this.dependencies.openFile(home);
    } catch (cause) {
      throw new ParallelsError(
        "opening",
        `Could not open “${vm.name}” in Parallels. The VM is running; try opening it in Control Center.`,
        { cause },
      );
    }
    return vm;
  }

  async controlVM(id: string, action: VMAction, progress?: (message: string) => void): Promise<VM> {
    const vm = await this.getVM(normalizeID(id));
    const active = vm.state === VMState.Running || vm.state === VMState.Paused;
    if (!active || (action === VMAction.Stop && vm.state !== VMState.Running)) {
      throw new ParallelsError("state", `Cannot ${action} “${vm.name}” while it is ${vm.rawState}. Refresh the list.`);
    }
    switch (action) {
      case VMAction.Suspend:
        return this.change(vm, ["suspend", vm.id], VMState.Suspended, progress);
      case VMAction.Stop:
        return this.change(vm, ["stop", vm.id, "--noforce"], VMState.Stopped, progress);
      case VMAction.ForceStop:
        return this.change(vm, ["stop", vm.id, "--kill"], VMState.Stopped, progress);
      case VMAction.Reset:
        return this.change(vm, ["reset", vm.id], VMState.Running, progress);
    }
  }

  async quitDesktop(): Promise<void> {
    const active = (await this.listVMs()).filter((vm) => ![VMState.Stopped, VMState.Suspended].includes(vm.state));
    if (active.length) {
      throw new ParallelsError(
        "state",
        `Shut down or suspend these VMs first: ${active.map((vm) => `${vm.name} (${vm.rawState})`).join(", ")}.`,
      );
    }
    await this.cli(PRLSRVCTL, ["shutdown"], CHANGE_TIMEOUT);
  }
}
