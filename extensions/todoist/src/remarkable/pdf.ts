/// <reference lib="es2022.intl" />
// The CommonJS entry avoids import.meta asset URLs in Raycast's CommonJS bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument: typeof import("pdfkit") = require("pdfkit");
import { readFile, writeFile } from "node:fs/promises";
import type { PlanSnapshot } from "./plan";

export type PdfRenderer = (snapshot: PlanSnapshot, output: string) => Promise<void>;
type Run = { text: string; font: string; width: number };
type Line = Run[];
const LEFT = 40;
const TOP = 40;
const LINE = 18;
const BODY = 12;
const clean = (text: string) => text.replace(/[\r\n\t]+/g, " ").normalize("NFC");

/** Direct text/vector PDF output: task text is never interpreted as HTML, Markdown or code. */
export async function createPlanPdf(snapshot: PlanSnapshot, output: string, emojiFontPath: string): Promise<void> {
  if (!snapshot.tasks.length) throw new Error("Velg minst én oppgave.");
  const [regular, bold, emoji] = await Promise.all([
    readFile("/System/Library/Fonts/Supplemental/Arial.ttf"),
    readFile("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    readFile(emojiFontPath),
  ]).catch(() => {
    throw new Error("Skriftene for PDF mangler. Installer utvidelsen på nytt og kontroller Arial i macOS.");
  });
  // Selecting an installed font avoids PDFKit's external AFM lookup in Raycast's bundled JS.
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    bufferPages: true,
    font: "/System/Library/Fonts/Supplemental/Arial.ttf",
    info: { Title: snapshot.name, Creator: "Todoist dagsplan", CreationDate: new Date(snapshot.createdAt) },
  });
  doc.registerFont("body", regular).registerFont("bold", bold).registerFont("emoji", emoji);
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - LEFT * 2;
  const bottom = doc.page.height - 52;
  let y = TOP;
  const segmenter = new Intl.Segmenter("nb", { granularity: "grapheme" });
  function runs(text: string, font: string, size: number): Run[] {
    const parts: Run[] = [];
    for (const { segment } of segmenter.segment(clean(text))) {
      const selected = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment) ? "emoji" : font;
      const last = parts[parts.length - 1];
      if (last?.font === selected) last.text += segment;
      else parts.push({ text: segment, font: selected, width: 0 });
    }
    for (const part of parts) part.width = doc.font(part.font).fontSize(size).widthOfString(part.text);
    return parts;
  }
  const measure = (text: string, font: string, size: number) => runs(text, font, size).reduce((n, r) => n + r.width, 0);
  function wrap(text: string, font = "body", size = BODY, maxWidth = width): Line[] {
    const lines: string[] = [];
    let line = "";
    for (const word of clean(text).split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, font, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      // Split even a long URL/unbroken title by grapheme; never clip or shrink body text.
      for (const { segment } of segmenter.segment(word)) {
        if (line && measure(line + segment, font, size) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += segment;
      }
    }
    if (line || !lines.length) lines.push(line);
    return lines.map((line) => runs(line, font, size));
  }
  function draw(line: Line, x: number, top: number, size = BODY) {
    for (const run of line) {
      doc.font(run.font).fontSize(size).fillColor("#111111").text(run.text, x, top, { lineBreak: false });
      x += run.width;
    }
  }
  function newPage() {
    doc.addPage();
    y = TOP;
    draw(runs(`Dagsplan ${snapshot.day} · fortsettelse`, "body", 10), LEFT, y, 10);
    y += 30;
  }
  function reserve(height: number) {
    if (y + height > bottom) newPage();
  }
  function paragraph(lines: Line[], x = LEFT, size = BODY, lineHeight = LINE) {
    for (const line of lines) {
      reserve(lineHeight);
      draw(line, x, y, size);
      y += lineHeight;
    }
  }
  function notes(count: number) {
    for (let i = 0; i < count; i++) {
      reserve(24);
      y += 24;
      doc
        .strokeColor("#AAAAAA")
        .lineWidth(0.45)
        .moveTo(LEFT, y)
        .lineTo(LEFT + width, y)
        .stroke();
    }
  }
  try {
    paragraph(wrap("Dagsplan", "bold", 28), LEFT, 28, 34);
    paragraph(wrap(`${snapshot.day} · ${snapshot.tasks.length} oppgaver · Europe/Oslo`, "body", 11), LEFT, 11, 17);
    y += 16;
    let project: string | undefined;
    for (const task of snapshot.tasks) {
      const title = wrap(task.title, "bold", BODY, width - 20);
      const context = task.parentTitle ? wrap(`Underoppgave av: ${task.parentTitle}`) : [];
      const details = wrap(
        [
          task.overdue ? "Forfalt" : undefined,
          task.due ? `Dato: ${task.due}${task.dueTime ? ` kl. ${task.dueTime}` : ""}` : undefined,
          `P${task.priority}`,
          task.deadline ? `Deadline: ${task.deadline}` : undefined,
          task.duration,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      const height = (title.length + context.length + details.length) * LINE + 8 + 48 + 18;
      let keepTogether = height <= bottom - 70;
      if (project !== task.projectId) {
        const heading = wrap(task.projectName, "bold", 19);
        keepTogether = height + heading.length * 25 + 12 <= bottom - 70;
        reserve((keepTogether ? height : LINE * 2) + heading.length * 25 + 12);
        paragraph(heading, LEFT, 19, 25);
        y += 12;
        project = task.projectId;
      }
      // Normal tasks stay intact, including both note lines. Oversized tasks continue at line boundaries.
      if (keepTogether) reserve(height);
      reserve(LINE);
      doc
        .strokeColor("#222222")
        .lineWidth(0.8)
        .rect(LEFT, y + 3, 9, 9)
        .stroke();
      paragraph(title, LEFT + 20);
      paragraph(context);
      y += 4;
      paragraph(details);
      reserve(52);
      y += 4;
      notes(2);
      y += 18;
    }
    reserve(25 + 8 * 24 + 12);
    paragraph(wrap("Notater", "bold", 19), LEFT, 19, 25);
    y += 12;
    notes(8);
    const { count } = doc.bufferedPageRange();
    for (let page = 0; page < count; page++) {
      doc.switchToPage(page);
      const label = runs(`${page + 1} / ${count}`, "body", 10);
      const length = label.reduce((sum, run) => sum + run.width, 0);
      draw(label, (doc.page.width - length) / 2, doc.page.height - 30, 10);
    }
    doc.end();
    await writeFile(output, await completed, { mode: 0o600 });
  } catch (error) {
    doc.destroy();
    // Attach a rejection handler even if layout fails before the stream is awaited.
    void completed.catch(() => {});
    throw error;
  }
}
