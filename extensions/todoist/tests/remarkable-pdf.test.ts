import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDocument, type PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createPlanPdf } from "../src/remarkable/pdf";
import { createSnapshot, type PlanTask } from "../src/remarkable/plan";

let directory: string;
let loading: PDFDocumentLoadingTask | undefined;
afterEach(async () => {
  await loading?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const task = (i: number): PlanTask => ({
  id: String(i),
  title: `Oppgave ${i} – æ, ø og å`,
  projectId: i < 7 ? "a" : "b",
  projectName: i < 7 ? "🧭 Arbeid" : "🛒 Hjem",
  priority: 1,
  overdue: false,
  due: "2026-09-24",
  dueTime: "09:30",
  duration: "30 min",
  deadline: "2026-09-25",
});
async function generate(tasks: PlanTask[]) {
  directory = await mkdtemp(path.join(os.tmpdir(), "daily-plan-pdf-"));
  const file = path.join(directory, "plan.pdf");
  await createPlanPdf(
    createSnapshot(tasks, new Set(tasks.map((t) => t.id)), new Date("2026-09-24T12:00:00Z")),
    file,
    path.resolve("assets/daily-plan/NotoEmoji.ttf"),
  );
  loading = getDocument({ data: new Uint8Array(await readFile(file)), isEvalSupported: false });
  return await loading.promise;
}
// These integration tests use the same installed macOS fonts as the macOS-only command.
describe.skipIf(process.platform !== "darwin")("actual generated PDF", () => {
  it("preserves Norwegian, emoji and literal text across A4 pages with a footer on every page", async () => {
    const tasks = Array.from({ length: 13 }, (_, i) => task(i));
    tasks[2].title = "Ærlig <script>hei</script> **tekst** & [lenke](url) 👨‍👩‍👧‍👦";
    tasks[3].parentTitle = "Forelder uten egen oppgave";
    tasks[4].title = "En lang tittel som må brytes over flere linjer ".repeat(9);
    const result = await generate(tasks);
    expect(result.numPages).toBeGreaterThan(2);
    let allText = "";
    for (let i = 1; i <= result.numPages; i++) {
      const page = await result.getPage(i);
      expect(page.view).toEqual([0, 0, 595.28, 841.89]);
      const content = await page.getTextContent();
      const items = content.items.filter((item) => "str" in item);
      const text = items.map((item) => item.str).join(" ");
      expect(text).toContain(`${i} / ${result.numPages}`);
      for (const item of items) {
        expect(item.transform[4]).toBeGreaterThanOrEqual(39);
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(557);
        expect(item.transform[5]).toBeGreaterThan(15);
        expect(item.transform[5]).toBeLessThan(810);
      }
      allText += text;
    }
    expect(allText).toContain("Ærlig <script>hei</script> **tekst** & [lenke](url)");
    expect(allText).toContain("🧭");
    expect(allText).toContain("🛒");
    expect(allText).toContain("æ, ø og å");
    expect(allText).toContain("Forelder uten egen oppgave");
    expect(allText).toContain("Deadline: 2026-09-25");
    expect(allText).toContain("Notater");
    expect(allText.match(/En lang tittel/g)).toHaveLength(9);
  });
  it("wraps unbroken text and a task taller than a page without losing its ending", async () => {
    const tasks = [task(0)];
    tasks[0].title = "Langtekst".repeat(650) + " SLUTTMERKE";
    const result = await generate(tasks);
    let text = "";
    for (let i = 1; i <= result.numPages; i++) {
      const page = await result.getPage(i);
      const content = await page.getTextContent();
      text += content.items
        .filter((item) => "str" in item)
        .map((item) => item.str)
        .join(" ");
    }
    expect(result.numPages).toBeGreaterThan(2);
    expect(text).toContain("SLUTTMERKE");
    expect(text).toContain("Notater");
  });
});
