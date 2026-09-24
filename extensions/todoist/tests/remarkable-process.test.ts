import { expect, it } from "vitest";
import { runProcess } from "../src/remarkable/process";
it("passes metacharacters literally without shell interpretation", async () => {
  const text = "$(echo bad); `echo bad` & æøå";
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", text]);
  expect(result).toEqual({ code: 0, stdout: text, stderr: "" });
});
it("terminates a timed-out process without exposing its output in the error", async () => {
  await expect(
    runProcess(process.execPath, ["-e", 'process.stderr.write("secret"); setInterval(()=>{},1000)'], { timeoutMs: 50 }),
  ).rejects.toThrow("for lang tid");
});
