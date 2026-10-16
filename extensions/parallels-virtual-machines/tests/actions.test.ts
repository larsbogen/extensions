import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  access: vi.fn(),
  end: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  confirm: vi.fn(),
  preferences: vi.fn(),
  commandSettings: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
vi.mock("@raycast/api", () => ({
  Alert: { ActionStyle: { Destructive: "destructive" } },
  closeMainWindow: mocks.close,
  confirmAlert: mocks.confirm,
  open: mocks.open,
  getPreferenceValues: mocks.preferences,
  openCommandPreferences: mocks.commandSettings,
  showToast: mocks.showToast,
  Toast: { Style: { Animated: "animated", Success: "success", Failure: "failure" } },
}));

import { openVM, runVMAction } from "../src/actions";
import OpenWindows from "../src/open-windows";
import OpenUbuntu from "../src/open-ubuntu";
import Shutdown from "../src/shutdown";
import { PARALLELS_BUNDLE_ID, parseVMs, PRLCTL, READ_TIMEOUT } from "../src/service";
import { VMAction } from "../src/types";

const id = "11111111-1111-4111-a111-111111111111";
const rows = [
  { ID: id, Name: "Windows 11", State: "running", Home: "/VMs/Windows 11.pvm/", OS: "win-11" },
  {
    ID: "22222222-2222-4222-a222-222222222222",
    Name: "Ubuntu 26.04 ARM64",
    State: "running",
    Home: "/VMs/Ubuntu 26.04 ARM64.pvm/",
    OS: "ubuntu",
  },
];
const vm = parseVMs(JSON.stringify(rows))[0];
let state: string;

beforeEach(() => {
  vi.resetAllMocks();
  state = "running";
  mocks.access.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue(undefined);
  mocks.commandSettings.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(false);
  mocks.showToast.mockImplementation(async (options) => ({ ...options, hide: vi.fn().mockResolvedValue(undefined) }));
  mocks.execFile.mockImplementation((_file, args, _options, callback) => {
    if (args[0] === "stop") state = "stopped";
    if (args[0] === "suspend") state = "suspended";
    callback(null, args[0] === "list" ? JSON.stringify(rows.map((row) => ({ ...row, State: state }))) : "", "");
    return { stdin: { end: mocks.end } };
  });
});

describe("Raycast actions and direct commands", () => {
  it.each([VMAction.ForceStop, VMAction.Reset])("cancelling %s sends no CLI call", async (action) => {
    await expect(runVMAction(vm, action)).resolves.toBe(false);
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining(vm.name),
        message: expect.stringContaining("Unsaved work may be lost"),
        primaryAction: expect.objectContaining({ style: "destructive" }),
      }),
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it.each([VMAction.ForceStop, VMAction.Reset])("%s executes only after confirmation", async (action) => {
    mocks.confirm.mockResolvedValue(true);
    await expect(runVMAction(vm, action)).resolves.toBe(true);
    const commands = mocks.execFile.mock.calls.filter(([, args]) => args[0] !== "list");
    expect(commands).toHaveLength(1);
    expect(commands[0][1]).toEqual(action === VMAction.Reset ? ["reset", id] : ["stop", id, "--kill"]);
    expect(mocks.confirm.mock.invocationCallOrder[0]).toBeLessThan(mocks.execFile.mock.invocationCallOrder[0]);
  });
  it("normal shutdown uses noforce without a force confirmation", async () => {
    await expect(runVMAction(vm, VMAction.Stop)).resolves.toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.execFile.mock.calls.filter(([, args]) => args[0] !== "list")[0][1]).toEqual(["stop", id, "--noforce"]);
  });
  it("passes argument arrays and timeouts to execFile and closes stdin", async () => {
    await openVM(id);
    expect(mocks.execFile).toHaveBeenCalledWith(
      PRLCTL,
      ["list", "--all", "--full", "--json", "--info"],
      expect.objectContaining({ timeout: READ_TIMEOUT, encoding: "utf8" }),
      expect.any(Function),
    );
    expect(mocks.execFile.mock.calls[0][2].shell).toBeUndefined();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
  it.each([
    ["Windows 11", OpenWindows, rows[0].Home],
    ["Ubuntu 26.04 ARM64", OpenUbuntu, rows[1].Home],
  ] as const)("%s opens the configured VM file through the explicit Parallels bundle", async (name, command, home) => {
    mocks.preferences.mockReturnValue({ vmIdentifier: name });
    await command();
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(home, PARALLELS_BUNDLE_ID);
    expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(mocks.open.mock.invocationCallOrder[0]);
  });
  it("a missing target offers command settings and never opens a different VM", async () => {
    await expect(openVM("Missing Windows")).resolves.toBe(false);
    const failure = mocks.showToast.mock.calls.find(([options]) => options.style === "failure")?.[0];
    expect(failure).toMatchObject({
      message: expect.stringContaining("No VM matches"),
      primaryAction: { title: "Open Command Settings" },
    });
    await failure.primaryAction.onAction();
    expect(mocks.commandSettings).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("an asynchronous opening rejection produces failure feedback, never a success toast", async () => {
    mocks.open.mockRejectedValue(new Error("Launch Services failed"));
    await expect(openVM(id)).resolves.toBe(false);
    expect(
      mocks.showToast.mock.calls.some(
        ([options]) => options.style === "failure" && options.message.includes("Could not open"),
      ),
    ).toBe(true);
    const toast = await mocks.showToast.mock.results[0].value;
    expect(toast.style).toBe("animated");
    expect(toast.hide).toHaveBeenCalledOnce();
  });
  it("the global shutdown command reports active VMs without stopping services", async () => {
    await Shutdown();
    expect(mocks.execFile.mock.calls.every(([, args]) => args[0] === "list")).toBe(true);
    expect(mocks.showToast.mock.calls.some(([options]) => options.message?.includes("Shut down or suspend"))).toBe(
      true,
    );
  });
});
