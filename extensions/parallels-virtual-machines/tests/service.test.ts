import { describe, expect, it, vi } from "vitest";
import {
  CHANGE_TIMEOUT,
  findVM,
  ParallelsError,
  ParallelsService,
  parseVMs,
  PRLCTL,
  PRLSRVCTL,
  READ_TIMEOUT,
  Runner,
} from "../src/service";
import { VMAction, VMState } from "../src/types";

const id = "11111111-1111-4111-a111-111111111111";
const otherID = "22222222-2222-4222-a222-222222222222";
const home = "/VMs/Windows 'work' $HOME; $(echo nope).pvm/";
const row = (State = "running", extra: Record<string, unknown> = {}) => ({
  ID: id,
  Name: "Windows 11",
  State,
  Home: home,
  OS: "win-11",
  Description: "",
  ...extra,
});

function fixture(states = ["running"], extra: Record<string, unknown> = {}) {
  let reads = 0;
  let clock = 0;
  const run = vi
    .fn<Runner>()
    .mockImplementation(async (_file, args) =>
      args[0] === "list" ? JSON.stringify([row(states[Math.min(reads++, states.length - 1)], extra)]) : "",
    );
  const openFile = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined);
  const exists = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined);
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const service = new ParallelsService({ run, openFile, exists, sleep, now: () => clock });
  const changes = () => run.mock.calls.filter(([, args]) => args[0] !== "list");
  return {
    service,
    run,
    openFile,
    exists,
    sleep,
    changes,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("VM data and target selection", () => {
  it.each(["", "not json", "{}", "null", "[null]", "[[]]"])("rejects invalid VM data: %s", (input) => {
    expect(() => parseVMs(input)).toThrow(ParallelsError);
  });
  it.each(["ID", "Name", "State"])("rejects a missing required %s", (field) => {
    expect(() => parseVMs(JSON.stringify([row("running", { [field]: undefined })]))).toThrow(/missing/);
  });
  it("rejects invalid or duplicate UUIDs", () => {
    expect(() => parseVMs(JSON.stringify([row("running", { ID: "--help" })]))).toThrow(/identifier/);
    expect(() => parseVMs(JSON.stringify([row(), row()]))).toThrow(/duplicate/);
  });
  it("accepts an empty list and normalizes braced UUIDs", () => {
    expect(parseVMs("[]")).toEqual([]);
    expect(parseVMs(JSON.stringify([row("running", { ID: `{${id.toUpperCase()}}` })]))[0].id).toBe(id);
  });
  it("selects an exact name or UUID, including special characters", () => {
    const name = "Ubuntu 'work' \"test\" $HOME; $(echo nope)";
    const vms = parseVMs(JSON.stringify([row("running", { Name: name })]));
    expect(findVM(vms, name).id).toBe(id);
    expect(findVM(vms, `{${id.toUpperCase()}}`).id).toBe(id);
    expect(() => findVM(vms, "Ubuntu")).toThrow(/No VM matches/);
  });
  it("rejects missing, blank and ambiguous targets instead of choosing the first", () => {
    const vms = parseVMs(JSON.stringify([row(), row("running", { ID: otherID })]));
    expect(() => findVM(vms, "Windows 11")).toThrow(/More than one/);
    expect(() => findVM(vms, "missing")).toThrow(/settings/);
    expect(() => findVM(vms, " ")).toThrow(/No VM matches/);
    expect(findVM(vms, otherID).id).toBe(otherID);
  });
});

describe("opening VMs", () => {
  it("opens an already running VM by its actual file, without power commands", async () => {
    const f = fixture();
    await f.service.openVM("Windows 11");
    expect(f.openFile).toHaveBeenCalledWith(home);
    expect(f.changes()).toEqual([]);
    expect(f.run).toHaveBeenCalledWith(PRLCTL, ["list", "--all", "--full", "--json", "--info"], READ_TIMEOUT);
  });
  it.each([
    ["stopped", "start"],
    ["suspended", "resume"],
    ["paused", "resume"],
  ])("%s: performs %s exactly once, waits, then opens", async (state, action) => {
    const f = fixture([state, action === "start" ? "starting" : "resuming", "running"]);
    await f.service.openVM("Windows 11");
    expect(f.changes()).toEqual([[PRLCTL, [action, id], CHANGE_TIMEOUT]]);
    expect(f.sleep).toHaveBeenCalledWith(2000);
    expect(f.openFile).toHaveBeenCalledExactlyOnceWith(home);
  });
  it.each(["starting", "resuming"])(
    "waits for an existing %s operation without sending a second command",
    async (state) => {
      const f = fixture([state, state, "running"]);
      await f.service.openVM(id);
      expect(f.changes()).toEqual([]);
      expect(f.openFile).toHaveBeenCalledOnce();
    },
  );
  it.each(["stopping", "suspending", "pausing", "inaccessible", "unavailable", "unexpected"])(
    "does not alter a VM that is %s",
    async (state) => {
      const f = fixture([state]);
      await expect(f.service.openVM(id)).rejects.toMatchObject({ code: "state" });
      expect(f.changes()).toEqual([]);
      expect(f.openFile).not.toHaveBeenCalled();
    },
  );
  it("refuses an opposite transition that begins while waiting", async () => {
    const f = fixture(["starting", "stopping"]);
    await expect(f.service.openVM(id)).rejects.toMatchObject({ code: "state" });
    expect(f.openFile).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "relative.pvm"])("does not start a VM with an invalid Home: %s", async (Home) => {
    const f = fixture(["stopped"], { Home });
    await expect(f.service.openVM(id)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.changes()).toEqual([]);
  });
  it("does not start a VM when its file is missing", async () => {
    const f = fixture(["stopped"]);
    f.exists.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(f.service.openVM(id)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.changes()).toEqual([]);
  });
  it("awaits asynchronous file opening and reports its rejection", async () => {
    const f = fixture();
    f.openFile.mockImplementation(async () => {
      await Promise.resolve();
      throw new Error("Launch Services failed");
    });
    await expect(f.service.openVM(id)).rejects.toMatchObject({ code: "opening" });
  });
  it("does not claim success or retry a slow start when the state never reaches running", async () => {
    const f = fixture(["stopped", "starting"]);
    await expect(f.service.openVM(id)).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("Current status: starting"),
    });
    expect(f.changes()).toHaveLength(1);
    expect(f.openFile).not.toHaveBeenCalled();
    expect(f.sleep).toHaveBeenCalledTimes(60);
  });
  it("uses the final status read when running is reached just at the deadline", async () => {
    const f = fixture(["starting"]);
    let reads = 0;
    f.run.mockImplementation(async () => JSON.stringify([row(++reads > 61 ? "running" : "starting")]));
    await f.service.openVM(id);
    expect(f.openFile).toHaveBeenCalledOnce();
    expect(f.changes()).toEqual([]);
  });
  it.each(["running", "starting"])(
    "reconciles a timed-out power command against %s without repeating it",
    async (state) => {
      const f = fixture();
      let reads = 0;
      f.run.mockImplementation(async (_file, args) => {
        if (args[0] === "list") return JSON.stringify([row(reads++ === 0 ? "stopped" : state)]);
        f.advance(CHANGE_TIMEOUT);
        throw Object.assign(new Error("timeout"), { killed: true });
      });
      if (state === "running") await f.service.openVM(id);
      else await expect(f.service.openVM(id)).rejects.toMatchObject({ code: "timeout" });
      expect(f.changes()).toHaveLength(1);
      expect(f.openFile).toHaveBeenCalledTimes(state === "running" ? 1 : 0);
      expect(reads).toBe(2);
    },
  );
  it("reconciles a timeout during polling of an external transition", async () => {
    const f = fixture();
    let reads = 0;
    f.run.mockImplementation(async () => {
      reads++;
      if (reads === 2) throw Object.assign(new Error("read timeout"), { code: "ETIMEDOUT" });
      return JSON.stringify([row(reads === 1 ? "resuming" : "running")]);
    });
    await f.service.openVM(id);
    expect(reads).toBe(3);
    expect(f.openFile).toHaveBeenCalledOnce();
    expect(f.changes()).toEqual([]);
  });
  it("reports an uncertain result when reconciliation also fails", async () => {
    const f = fixture();
    let reads = 0;
    f.run.mockImplementation(async (_file, args) => {
      if (args[0] === "list" && reads++ === 0) return JSON.stringify([row("stopped")]);
      throw Object.assign(new Error("timeout"), { killed: true });
    });
    await expect(f.service.openVM(id)).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("uncertain"),
    });
    expect(f.changes()).toHaveLength(1);
    expect(f.openFile).not.toHaveBeenCalled();
  });
  it("fails safely if the VM disappears during startup", async () => {
    const f = fixture();
    let reads = 0;
    f.run.mockImplementation(async (_file, args) =>
      args[0] === "list" ? JSON.stringify(reads++ === 0 ? [row("stopped")] : []) : "",
    );
    await expect(f.service.openVM(id)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.changes()).toHaveLength(1);
    expect(f.openFile).not.toHaveBeenCalled();
  });
  it("does not open or retry when startup is rejected", async () => {
    const f = fixture();
    f.run.mockImplementation(async (_file, args) => {
      if (args[0] === "list") return JSON.stringify([row("stopped")]);
      throw new Error("Not enough memory to start this VM");
    });
    await expect(f.service.openVM(id)).rejects.toMatchObject({ code: "command" });
    expect(f.changes()).toHaveLength(1);
    expect(f.openFile).not.toHaveBeenCalled();
  });
  it("awaits the actual open operation before reporting completion", async () => {
    const f = fixture();
    let finish!: () => void;
    const opening = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.openFile.mockReturnValue(opening);
    let completed = false;
    const result = f.service.openVM(id).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(f.openFile).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    finish();
    await result;
    expect(completed).toBe(true);
  });
});

describe("VM controls", () => {
  it.each([
    [VMAction.Stop, ["stop", id, "--noforce"], "stopped"],
    [VMAction.Suspend, ["suspend", id], "suspended"],
    [VMAction.ForceStop, ["stop", id, "--kill"], "stopped"],
    [VMAction.Reset, ["reset", id], "running"],
  ] as const)(
    "%s sends only its explicit arguments and waits for the resulting status",
    async (action, args, status) => {
      const f = fixture(["running", status]);
      await expect(f.service.controlVM(id, action)).resolves.toMatchObject({ state: status });
      expect(f.changes()).toEqual([[PRLCTL, [...args], CHANGE_TIMEOUT]]);
    },
  );
  it("does not escalate a failed normal shutdown", async () => {
    const f = fixture();
    f.run.mockImplementation(async (_file, args) => {
      if (args[0] === "list") return JSON.stringify([row()]);
      throw new Error("Guest did not consent to shutdown");
    });
    await expect(f.service.controlVM(id, VMAction.Stop)).rejects.toMatchObject({ code: "command" });
    expect(f.changes()).toEqual([[PRLCTL, ["stop", id, "--noforce"], CHANGE_TIMEOUT]]);
  });
  it("does not escalate a shutdown that times out", async () => {
    const f = fixture(["running", "stopping"]);
    await expect(f.service.controlVM(id, VMAction.Stop)).rejects.toMatchObject({ code: "timeout" });
    expect(f.changes()).toEqual([[PRLCTL, ["stop", id, "--noforce"], CHANGE_TIMEOUT]]);
  });
  it("rechecks status before acting on a stale list item", async () => {
    const f = fixture(["stopped"]);
    await expect(f.service.controlVM(id, VMAction.ForceStop)).rejects.toMatchObject({ code: "state" });
    expect(f.changes()).toEqual([]);
  });
});

describe("quitting Parallels Desktop", () => {
  it.each(["running", "paused", "starting", "resuming", "stopping", "suspending", "unknown", "inaccessible"])(
    "refuses to quit with a %s VM",
    async (state) => {
      const f = fixture([state]);
      await expect(f.service.quitDesktop()).rejects.toMatchObject({
        code: "state",
        message: expect.stringContaining("Windows 11"),
      });
      expect(f.changes()).toEqual([]);
    },
  );
  it("quits without force only after every VM is stopped or suspended", async () => {
    const f = fixture();
    f.run.mockImplementation(async (_file, args) =>
      args[0] === "list" ? JSON.stringify([row("stopped"), row("suspended", { ID: otherID })]) : "",
    );
    await f.service.quitDesktop();
    expect(f.changes()).toEqual([[PRLSRVCTL, ["shutdown"], CHANGE_TIMEOUT]]);
  });
});

describe("CLI error reporting", () => {
  it.each([
    [{ code: "ENOENT", message: "not found" }, "cli-missing"],
    [{ code: "ETIMEDOUT", message: "timeout" }, "timeout"],
    [
      {
        message: "failure",
        stderr: "The command is available only in Parallels Desktop for Mac Pro or Business Edition.",
      },
      "license",
    ],
    [{ message: "failure", stderr: "Unable to connect to Parallels Service" }, "command"],
  ])("classifies %j accurately", async (error, code) => {
    const f = fixture();
    f.run.mockRejectedValue(error);
    await expect(f.service.listVMs()).rejects.toMatchObject({ code });
  });
  it("retains unknown states for a useful status description", () => {
    expect(parseVMs(JSON.stringify([row("new-state")]))[0]).toMatchObject({
      state: VMState.Unknown,
      rawState: "new-state",
    });
  });
});
