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
    path.resolve("assets/daily-plan"),
  );
  loading = getDocument({ data: new Uint8Array(await readFile(file)), isEvalSupported: false });
  return await loading.promise;
}
// Letter-spaced labels are extracted with gaps between letters.
const squash = (text: string) => text.replace(/\s+/g, "");
async function pageTexts(result: Awaited<ReturnType<typeof generate>>) {
  const texts: string[] = [];
  for (let i = 1; i <= result.numPages; i++) {
    const content = await (await result.getPage(i)).getTextContent();
    texts.push(
      content.items
        .filter((item) => "str" in item)
        .map((item) => item.str)
        .join(" "),
    );
  }
  return texts;
}
describe("actual generated PDF", () => {
  it("preserves Norwegian, emoji and literal text across reMarkable pages with a footer on every page", async () => {
    const tasks = Array.from({ length: 13 }, (_, i) => task(i));
    tasks[2].title = "Ærlig <script>hei</script> **tekst** & [lenke](url) 👨‍👩‍👧‍👦";
    tasks[3].parentTitle = "Forelder uten egen oppgave";
    tasks[5].overdue = true;
    tasks[5].due = "2026-09-20";
    tasks[4].title = "En lang tittel som må brytes over flere linjer ".repeat(9);
    // Keep the title out of the timeline so every occurrence below comes from the task list.
    tasks[4].dueTime = undefined;
    const result = await generate(tasks);
    expect(result.numPages).toBeGreaterThan(2);
    let allText = "";
    for (let i = 1; i <= result.numPages; i++) {
      const page = await result.getPage(i);
      expect(page.view).toEqual([0, 0, 447, 596]);
      const content = await page.getTextContent();
      const items = content.items.filter((item) => "str" in item);
      const text = items.map((item) => item.str).join(" ");
      expect(text).toContain(`${i} / ${result.numPages}`);
      expect(text).toContain("Torsdag 24.09");
      for (const item of items) {
        expect(item.transform[4]).toBeGreaterThanOrEqual(39);
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(420);
        expect(item.transform[5]).toBeGreaterThan(15);
        expect(item.transform[5]).toBeLessThan(570);
      }
      allText += text;
    }
    expect(allText).toContain("Ærlig <script>hei</script> **tekst** & [lenke](url)");
    expect(allText).toContain("🧭");
    expect(allText).toContain("🛒");
    expect(allText).toContain("æ, ø og å");
    expect(allText).toContain("Forelder uten egen oppgave");
    expect(squash(allText)).toContain("DAGSPLAN·UKE39");
    expect(allText).toContain("Torsdag 24. september");
    expect(allText).toContain("13 oppgaver · 1 forfalt · ca. 6 t 30 min estimert");
    expect(squash(allText)).toContain("DAGENSFOKUS");
    expect(squash(allText)).toContain("TIDSLINJE");
    expect(squash(allText)).toContain("FORFALT");
    expect(allText).toContain("kl. 09:30 · 30 min · Frist 25.09");
    expect(allText).toContain("20.09 kl. 09:30");
    expect(allText).not.toContain("P1");
    expect(squash(allText)).toContain("NOTATER");
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
    expect(squash(text)).toContain("NOTATER");
  });
  it("nests selected subtasks under their parent and captions subtasks whose parent is not in the plan", async () => {
    const tasks = [task(0), task(1), task(2)];
    tasks[0].title = "Barn";
    tasks[0].parentId = "2";
    tasks[0].parentTitle = "Forelder";
    tasks[1].title = "Foreldreløs";
    tasks[1].parentId = "missing";
    tasks[1].parentTitle = "Utenfor planen";
    tasks[2].title = "Forelder";
    const [text] = await pageTexts(await generate(tasks));
    expect(text.indexOf("Forelder")).toBeLessThan(text.lastIndexOf("Barn"));
    expect(text).toContain("↳ Utenfor planen");
    expect(text).not.toContain("↳ Forelder");
  });
  it("places only today's timed tasks in the timeline and summarises the rest", async () => {
    const tasks = Array.from({ length: 14 }, (_, i) => ({ ...task(i), title: `Møte ${i}`, dueTime: "09:00" }));
    tasks[0].due = "2026-09-23";
    const [first] = await pageTexts(await generate(tasks));
    expect(first).toMatch(/09:00\s+Møte 1 /);
    expect(first).not.toMatch(/09:00\s+Møte 0 /);
    expect(first).toMatch(/\+ \d+ til i listen/);
  });
});
