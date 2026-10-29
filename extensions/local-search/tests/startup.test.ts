import { it, expect, vi, afterEach } from "vitest";
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_f, _a, _o, cb) => {
    queueMicrotask(() => cb(null, "http://127.0.0.1:9876\n"));
    return { stdin: { end: vi.fn() } };
  }),
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () =>
    JSON.stringify({ url: "http://127.0.0.1:9876", instance: "synthetic" }),
  ),
}));
import { execFile } from "node:child_process";
import { Services } from "../src/service";
afterEach(() => vi.clearAllMocks());
it("samordner samtidig oppstart og bruker faktisk port uten å åpne nettleseren", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      service: "uia-thesis-library",
      root: "/tmp/library",
      instance: "synthetic",
    }),
  );
  const s = new Services({ libraryPath: "/tmp/library" });
  const [a, b] = await Promise.all([
    s.connect("library"),
    s.connect("library"),
  ]);
  expect(a).toBe(b);
  expect(a.baseUrl).toBe("http://127.0.0.1:9876");
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(vi.mocked(execFile).mock.calls[0][1]).toEqual([
    "control.py",
    "start",
    "--no-open",
  ]);
});
it("avviser fremmed tjeneste uten å stoppe den", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      service: "other",
      root: "/tmp/library",
      instance: "synthetic",
    }),
  );
  const s = new Services({ libraryPath: "/tmp/library" });
  await expect(s.connect("library")).rejects.toThrow("serveridentitet");
  expect(execFile).toHaveBeenCalledTimes(1);
});
