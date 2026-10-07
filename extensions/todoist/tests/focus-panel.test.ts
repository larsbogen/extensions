import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@raycast/api", () => ({ environment: { supportPath: "/unused", assetsPath: "/unused" } }));
vi.mock("@raycast/utils", () => ({
  createDeeplink: () => "raycast://extensions/thomaslombart/todoist/complete-focused-task",
}));

import { createFocusPanelClient } from "../src/focus/panel";

describe("floating focus panel bridge", () => {
  let root: string;
  let executable: string;
  let directory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "todoist-focus-test-"));
    executable = join(root, "helper");
    directory = join(root, "session");
    await writeFile(executable, "test helper");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function requestFile() {
    const files = (await readdir(join(directory, "requests"))).filter((name) => name.endsWith(".json")).sort();
    return join(directory, "requests", files[0]);
  }
  let lastRequest: Record<string, unknown>;
  async function acknowledge() {
    const files = (await readdir(join(directory, "requests"))).filter((name) => name.endsWith(".json")).sort();
    let state: { requestId?: string; acknowledgedRequests: string[] } = { acknowledgedRequests: [] };
    try {
      state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      state.acknowledgedRequests ??= [];
    } catch {
      /* first startup */
    }
    for (const file of files) {
      const request = JSON.parse(await readFile(join(directory, "requests", file), "utf8"));
      expect((await stat(join(directory, "requests", file))).mode & 0o777).toBe(0o600);
      lastRequest = request;
      state = { requestId: request.id, acknowledgedRequests: [...state.acknowledgedRequests, request.id] };
      await writeFile(join(directory, "state.json"), JSON.stringify(state));
      await rm(join(directory, "requests", file), { force: true });
    }
  }

  it("enables the completion command so Raycast can launch it from the card", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const command = manifest.commands.find((command: { name: string }) => command.name === "complete-focused-task");
    expect(command).toBeDefined();
    expect(command.mode).toBe("no-view");
    expect(command.disabledByDefault).not.toBe(true);
  });

  it("preserves long, multilingual titles and quotes through JSON without a shell", async () => {
    const launch = vi.fn(acknowledge);
    const client = createFocusPanelClient({ executable, directory, launch });
    const content = '**Lage dagsplan** for æøå 👩‍💻 — "viktig" `$(touch injected)` ' + "hele tittelen ".repeat(30);
    await client.start({ id: "id/with space", content }, 25);
    const request = lastRequest as { duration: number; task: { title: string; url: string; completionURL: string } };
    expect(request.duration).toBe(1500);
    expect(request.task.title).toContain('æøå 👩‍💻 — "viktig" $(touch injected)');
    expect(request.task.title).toContain("hele tittelen ".repeat(30));
    expect(request.task.url).toBe("https://todoist.com/app/task/id%2Fwith%20space");
    expect(request.task.completionURL).toContain("/complete-focused-task");
    expect(launch).toHaveBeenCalledWith(executable, directory);
    expect((await stat(join(directory, "requests"))).mode & 0o777).toBe(0o700);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("serializes rapid selections, then targets stop to the correct task", async () => {
    const requests: { action: string; taskId?: string; task?: { id: string } }[] = [];
    const client = createFocusPanelClient({
      executable,
      directory,
      launch: async () => {
        requests.push(JSON.parse(await readFile(await requestFile(), "utf8")));
        await acknowledge();
      },
    });
    await Promise.all([client.start({ id: "a", content: "A" }, 15), client.start({ id: "b", content: "B" }, 0)]);
    await client.stop("a");
    expect(requests.map((request) => request.task?.id ?? request.taskId)).toEqual(["a", "b", "a"]);
    expect(requests[2].action).toBe("stop");
  });

  it("keeps project metadata and acknowledges concurrent independent Raycast clients", async () => {
    let processing = Promise.resolve();
    const launch = () => {
      processing = processing.then(acknowledge);
      return processing;
    };
    const first = createFocusPanelClient({ executable, directory, launch });
    const second = createFocusPanelClient({ executable, directory, launch });
    await Promise.all([
      first.start({ id: "a", content: "A", projectId: "project-a" }, 25),
      second.start({ id: "b", content: "B", projectId: "project-b" }, 25),
    ]);
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    expect(state.acknowledgedRequests).toHaveLength(2);
    expect(lastRequest.task).toEqual(expect.objectContaining({ projectId: expect.stringMatching(/^project-/) }));
    expect(await readdir(join(directory, "requests"))).toEqual([]);
  });

  it("can show pending Toggl work after the Todoist focus has been cleared", async () => {
    const client = createFocusPanelClient({ executable, directory, launch: acknowledge });
    expect(await client.showPending()).toBe(false);
    await client.start({ id: "a", content: "A" }, 25);
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({
        session: { id: "saved-session", phase: "ended" },
        tracking: { periods: [{ sync: "review" }] },
      }),
    );
    expect(await client.showPending()).toBe(true);
    expect(lastRequest.action).toBe("show");
  });

  it("targets stop to the saved session so a late command cannot stop a new session of the same task", async () => {
    const client = createFocusPanelClient({ executable, directory, launch: acknowledge });
    await client.start({ id: "a", content: "A" }, 25);
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({ session: { id: "saved-session", task: { id: "a" } } }),
    );
    await client.stop("a");
    expect(lastRequest).toEqual(expect.objectContaining({ taskId: "a", sessionId: "saved-session" }));
  });

  it("does not report success before the helper has acknowledged the request", async () => {
    const client = createFocusPanelClient({ executable, directory, launch: async () => undefined, timeoutMs: 10 });
    await expect(client.start({ id: "a", content: "A" }, 25)).rejects.toThrow("svarte ikke");
  });

  it("reports missing builds and invalid durations without launching anything", async () => {
    const launch = vi.fn();
    const client = createFocusPanelClient({ executable: join(root, "missing"), directory, launch });
    await expect(client.start({ id: "a", content: "A" }, 25)).rejects.toThrow("npm run build:focus");
    for (const minutes of [-1, Infinity, NaN, 1441]) {
      await expect(client.start({ id: "a", content: "A" }, minutes)).rejects.toThrow("Øktlengden");
    }
    await expect(client.start({ id: "", content: "A" }, 25)).rejects.toThrow("Ingen fokusoppgave");
    expect(launch).not.toHaveBeenCalled();
  });

  it("can retry after a launch failure and never starts a helper for an unused session", async () => {
    const launch = vi.fn().mockRejectedValueOnce(new Error("launch failed")).mockImplementation(acknowledge);
    const client = createFocusPanelClient({ executable, directory, launch });
    await client.stop();
    expect(launch).not.toHaveBeenCalled();
    await expect(client.start({ id: "a", content: "A" }, 25)).rejects.toThrow("launch failed");
    await client.start({ id: "a", content: "A" }, 25);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("retries when a just-stopped helper still holds the native process lock", async () => {
    const launch = vi.fn().mockResolvedValueOnce(undefined).mockImplementation(acknowledge);
    const client = createFocusPanelClient({ executable, directory, launch, timeoutMs: 2500 });
    await client.start({ id: "next", content: "Next task" }, 25);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("accepts an equivalent stop from another Raycast command", async () => {
    const client = createFocusPanelClient({
      executable,
      directory,
      launch: async () => {
        await writeFile(
          join(directory, "state.json"),
          JSON.stringify({ requestId: "other-command", session: { task: { id: "a" }, phase: "ended" } }),
        );
      },
      timeoutMs: 10,
    });
    // Model an already existing session, as produced by the helper.
    await createFocusPanelClient({ executable, directory, launch: acknowledge }).start({ id: "a", content: "A" }, 25);
    await expect(client.stop("a")).resolves.toBeUndefined();
  });
});
