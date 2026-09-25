/// <reference lib="es2022.intl" />
// The CommonJS entry avoids import.meta asset URLs in Raycast's CommonJS bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument: typeof import("pdfkit") = require("pdfkit");
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nestTasks, type PlanSnapshot, type PlanTask } from "./plan";

export type PdfRenderer = (snapshot: PlanSnapshot, output: string) => Promise<void>;

/** reMarkable screens are 3:4 (1404×1872 px at 226 dpi ≈ 447×596 pt), so pages fill the display unscaled. */
export const PAGE_SIZE = [447, 596] as const;
const [PAGE_W, PAGE_H] = PAGE_SIZE;
// The wider left margin keeps text clear of the reMarkable toolbar.
const LEFT = 40;
const RIGHT = PAGE_W - 28;
const WIDTH = RIGHT - LEFT;
const TOP = 34;
const BOTTOM = PAGE_H - 40;
const TASK_W = 238;
const NOTES_X = LEFT + TASK_W + 14;
const DOT = 14.17; // 5 mm, like reMarkable's dot templates.
const INK = "#111111";
const MUTED = "#5f5f5f";
const FAINT = "#8c8c8c";
const RULE = "#b4b4b4";

const FONTS = {
  body: "Inter-Regular.ttf",
  medium: "Inter-Medium.ttf",
  semibold: "Inter-SemiBold.ttf",
  display: "InterDisplay-SemiBold.ttf",
  emoji: "NotoEmoji.ttf",
};
type FontName = keyof typeof FONTS;
type Style = { font: FontName; size: number; color?: string; spacing?: number };
type Run = { text: string; font: FontName; width: number };
type Line = { runs: Run[]; width: number };

const LABEL: Style = { font: "semibold", size: 7, color: MUTED, spacing: 0.9 };
const HEADING: Style = { font: "semibold", size: 8, spacing: 0.8 };
const TITLE: Style = { font: "medium", size: 10.5 };
const META: Style = { font: "body", size: 8, color: MUTED };
const CAPTION: Style = { font: "body", size: 7.5, color: MUTED };
const TAG: Style = { font: "semibold", size: 6.2, color: "#ffffff", spacing: 0.5 };
const TITLE_LH = 14;
const META_LH = 11;
const CAPTION_LH = 10.5;
const PAD = 7;
const MIN_BLOCK = 34; // Leaves room for a handwritten note beside short tasks.
const HEADING_H = 19;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

const clean = (text: string) => text.replace(/[\r\n\t]+/g, " ").normalize("NFC");
const calendar = (day: string) => new Date(`${day}T12:00:00Z`);
const short = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase("nb-NO") + text.slice(1);
const format = (day: string, options: Intl.DateTimeFormatOptions) =>
  capitalize(new Intl.DateTimeFormat("nb-NO", { timeZone: "UTC", ...options }).format(calendar(day)));

function isoWeek(day: string): number {
  const date = calendar(day);
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / 604800000);
}

// Old snapshots store only the formatted duration, so the total is derived from it.
function estimate(tasks: PlanTask[]): string | undefined {
  const minutes = tasks.reduce((sum, task) => sum + Number(task.duration?.match(/^(\d+) min$/)?.[1] ?? 0), 0);
  if (!minutes) return undefined;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `ca. ${[hours ? `${hours} t` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ")} estimert`;
}

function details(task: PlanTask, day: string): string {
  const due =
    task.due && task.due !== day
      ? `${short(task.due)}${task.dueTime ? ` kl. ${task.dueTime}` : ""}`
      : task.dueTime
        ? `kl. ${task.dueTime}`
        : undefined;
  const deadline = task.deadline && (task.deadline === day ? "Frist i dag" : `Frist ${short(task.deadline)}`);
  return [due, task.duration, deadline].filter(Boolean).join(" · ");
}

/** Direct text/vector PDF output: task text is never interpreted as HTML, Markdown or code. */
export async function createPlanPdf(snapshot: PlanSnapshot, output: string, fontDirectory: string): Promise<void> {
  if (!snapshot.tasks.length) throw new Error("Velg minst én oppgave.");
  const names = Object.keys(FONTS) as FontName[];
  const fonts = await Promise.all(names.map((name) => readFile(path.join(fontDirectory, FONTS[name])))).catch(() => {
    throw new Error("Skriftene for PDF mangler. Installer utvidelsen på nytt.");
  });
  // Selecting a bundled font avoids PDFKit's external AFM lookup in Raycast's bundled JS.
  const doc = new PDFDocument({
    size: [...PAGE_SIZE],
    margin: 0,
    bufferPages: true,
    font: path.join(fontDirectory, FONTS.body),
    info: { Title: snapshot.name, Creator: "Todoist dagsplan", CreationDate: new Date(snapshot.createdAt) },
  });
  names.forEach((name, i) => doc.registerFont(name, fonts[i]));
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const segmenter = new Intl.Segmenter("nb", { granularity: "grapheme" });
  const longDate = format(snapshot.day, { weekday: "long", day: "numeric", month: "long" });

  // Inter's OpenType layout is costly, so widths are cached; wrapping reuses word and grapheme widths.
  const widths = new Map<string, number>();
  function measure(text: string, font: FontName, style: Style): number {
    const key = `${font}\u0000${style.size}\u0000${style.spacing ?? 0}\u0000${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      width = doc
        .font(font)
        .fontSize(style.size)
        .widthOfString(text, { characterSpacing: style.spacing ?? 0 });
      widths.set(key, width);
    }
    return width;
  }
  function runs(text: string, style: Style): Line {
    const parts: Run[] = [];
    for (const { segment } of segmenter.segment(clean(text))) {
      const font = EMOJI.test(segment) ? "emoji" : style.font;
      const last = parts[parts.length - 1];
      if (last?.font === font) last.text += segment;
      else parts.push({ text: segment, font, width: 0 });
    }
    for (const part of parts) part.width = measure(part.text, part.font, style);
    const spacing = style.spacing ?? 0;
    return { runs: parts, width: parts.reduce((sum, run) => sum + run.width, 0) + spacing * (parts.length - 1) };
  }
  function wrap(text: string, style: Style, maxWidth: number): Line[] {
    const spacing = style.spacing ?? 0;
    const width = (piece: string) => runs(piece, style).width;
    const space = width(" ") + spacing * 2;
    const lines: string[] = [];
    let line = "";
    let used = 0;
    const flush = () => {
      if (line) lines.push(line);
      line = "";
      used = 0;
    };
    for (const word of clean(text).split(/\s+/)) {
      const size = width(word);
      if (line && used + space + size <= maxWidth) {
        line += ` ${word}`;
        used += space + size;
        continue;
      }
      flush();
      if (size <= maxWidth) {
        line = word;
        used = size;
        continue;
      }
      // Split even a long URL/unbroken title by grapheme; never clip or shrink task text.
      for (const { segment } of segmenter.segment(word)) {
        const next = width(segment) + (line ? spacing : 0);
        if (line && used + next > maxWidth) flush();
        line += segment;
        used += line === segment ? width(segment) : next;
      }
    }
    if (line || !lines.length) lines.push(line);
    return lines.map((line) => runs(line, style));
  }
  // Only the timeline shortens text; every task is printed in full in the list below it.
  function ellipsize(text: string, style: Style, maxWidth: number): Line {
    const full = runs(text, style);
    if (full.width <= maxWidth) return full;
    const limit = maxWidth - runs("…", style).width;
    let kept = "";
    let used = 0;
    for (const { segment } of segmenter.segment(clean(text))) {
      used += runs(segment, style).width + (style.spacing ?? 0);
      if (used > limit) break;
      kept += segment;
    }
    return runs(`${kept.trimEnd()}…`, style);
  }
  function draw(line: Line, x: number, baseline: number, style: Style) {
    const spacing = style.spacing ?? 0;
    for (const run of line.runs) {
      doc
        .font(run.font)
        .fontSize(style.size)
        .fillColor(style.color ?? INK)
        .text(run.text, x, baseline, { lineBreak: false, baseline: "alphabetic", characterSpacing: spacing });
      x += run.width + spacing;
    }
  }
  function rule(x0: number, x1: number, at: number, width: number, color: string) {
    doc.lineWidth(width).strokeColor(color).moveTo(x0, at).lineTo(x1, at).stroke();
  }
  // Dots share one page-wide grid so the notes column and notes section line up.
  function dots(x0: number, x1: number, top: number, bottom: number) {
    const first = (start: number, anchor: number) => anchor + Math.ceil((start - anchor) / DOT - 1e-6) * DOT;
    for (let y = first(top, TOP); y <= bottom; y += DOT)
      for (let x = RIGHT - Math.floor((RIGHT - x0) / DOT) * DOT; x <= x1 + 0.01; x += DOT) doc.circle(x, y, 0.6);
    doc.fillColor(FAINT).fill();
  }

  let y = TOP;
  let listing = false;
  let fresh = true;
  let gridTop = 0;
  let project: { name: string; count: number } | undefined;
  const page = () => doc.bufferedPageRange().count - 1;
  function heading(name: string, count?: number, continued = false) {
    y += 12;
    const muted = { ...HEADING, color: MUTED };
    const suffix = continued ? runs(" · FORTS.", muted) : undefined;
    const number = count === undefined ? undefined : runs(String(count), muted);
    // The count sits at the task column's edge, or the page edge when a long name needs the room.
    const room = (edge: number) => edge - LEFT - (number ? number.width + 10 : 0) - (suffix?.width ?? 0);
    const upper = name.toLocaleUpperCase("nb-NO");
    const edge = runs(upper, HEADING).width <= room(LEFT + TASK_W) ? LEFT + TASK_W : RIGHT;
    const label = ellipsize(upper, HEADING, room(edge));
    draw(label, LEFT, y, HEADING);
    if (suffix) draw(suffix, LEFT + label.width, y, muted);
    if (number) draw(number, edge - number.width, y, muted);
    y += 5;
    rule(LEFT, RIGHT, y, 0.8, INK);
    y += 2;
  }
  function closeGrid(to: number) {
    if (listing && to - gridTop > 4) dots(NOTES_X, RIGHT, gridTop + 4, to - 4);
  }
  function newPage() {
    closeGrid(BOTTOM);
    doc.addPage();
    const style: Style = { font: "body", size: 7.5, color: MUTED };
    draw(runs(`${longDate} · fortsettelse`, style), LEFT, TOP + 8, style);
    rule(LEFT, RIGHT, TOP + 14, 0.5, RULE);
    y = TOP + 22;
    fresh = true;
    if (listing && project) heading(project.name, project.count, true);
    gridTop = y;
  }
  function reserve(height: number) {
    if (y + height > BOTTOM) newPage();
  }
  const baseline = (lineHeight: number, style: Style) => y + lineHeight / 2 + style.size * 0.36;
  function lines(content: Line[], x: number, style: Style, lineHeight: number, first?: (top: number) => void) {
    content.forEach((line, i) => {
      reserve(lineHeight);
      if (i === 0) first?.(y);
      draw(line, x, baseline(lineHeight, style), style);
      y += lineHeight;
    });
  }

  function masthead() {
    const overdue = snapshot.tasks.filter((task) => task.overdue).length;
    const count = snapshot.tasks.length;
    const label = `Dagsplan · Uke ${isoWeek(snapshot.day)}`.toLocaleUpperCase("nb-NO");
    draw(runs(label, LABEL), LEFT, TOP + 7, LABEL);
    const title: Style = { font: "display", size: 24 };
    draw(runs(longDate, title), LEFT, TOP + 33, title);
    const summary = [
      `${count} ${count === 1 ? "oppgave" : "oppgaver"}`,
      overdue ? `${overdue} forfalt` : undefined,
      estimate(snapshot.tasks),
    ];
    const style: Style = { font: "body", size: 9, color: MUTED };
    draw(runs(summary.filter(Boolean).join(" · "), style), LEFT, TOP + 49, style);
    rule(LEFT, RIGHT, TOP + 59, 1.2, INK);
    y = TOP + 75;
  }

  function planning() {
    const column = (WIDTH - 20) / 2;
    const timeX = LEFT + column + 20;
    draw(runs("DAGENS FOKUS", LABEL), LEFT, y + 7, LABEL);
    draw(runs("TIDSLINJE", LABEL), timeX, y + 7, LABEL);
    const top = y + 18;
    const timed = snapshot.tasks
      .filter((task) => task.due === snapshot.day && task.dueTime)
      .map((task) => ({ task, hour: Number(task.dueTime!.slice(0, 2)) + Number(task.dueTime!.slice(3, 5)) / 60 }))
      .sort((a, b) => a.hour - b.hour);
    const first = Math.min(8, ...timed.map((t) => Math.floor(t.hour)));
    const last = Math.max(17, ...timed.map((t) => Math.floor(t.hour) + 1));
    const row = Math.max(8, Math.min(12.5, 125 / (last - first)));
    const height = (last - first) * row;
    const hourStyle: Style = { font: "body", size: 6.8, color: MUTED };
    const lineX = timeX + 14;
    for (let hour = first; hour <= last; hour++) {
      const at = top + (hour - first) * row;
      draw(runs(String(hour).padStart(2, "0"), hourStyle), timeX, at + 2.3, hourStyle);
      rule(
        lineX,
        RIGHT,
        at,
        hour === first || hour === last ? 0.6 : 0.35,
        hour === first || hour === last ? INK : RULE,
      );
    }
    // Like a calendar, each task sits in its hour's row; later tasks in a full hour move down a row.
    const entry: Style = { font: "medium", size: 7.2 };
    const rows = last - first;
    let slot = -1;
    for (const [i, { task, hour }] of timed.entries()) {
      slot = Math.max(Math.floor(hour) - first, slot + 1);
      const center = top + (Math.min(slot, rows - 1) + 0.5) * row;
      if (slot >= rows - 1 && i < timed.length - 1) {
        draw(runs(`+ ${timed.length - i} til i listen`, hourStyle), lineX + 5, center + 2.4, hourStyle);
        break;
      }
      doc
        .circle(lineX + 1.5, center, 1.6)
        .fillColor(INK)
        .fill();
      draw(ellipsize(`${task.dueTime}  ${task.title}`, entry, RIGHT - lineX - 6), lineX + 5.5, center + 2.6, entry);
    }
    const number: Style = { font: "display", size: 13, color: FAINT };
    for (let i = 0; i < 3; i++) {
      // The last line shares the timeline's closing rule.
      const at = top + 24 + i * ((height - 24) / 2);
      draw(runs(String(i + 1), number), LEFT, at - 2, number);
      rule(LEFT + 14, LEFT + column, at, 0.6, INK);
    }
    y = top + height + 12;
  }

  function priority(task: PlanTask, top: number) {
    const x = LEFT + TASK_W - 4;
    const center = top + TITLE_LH / 2;
    if (task.priority === 1) doc.circle(x, center, 3.2).fillColor(INK).fill();
    if (task.priority === 2) {
      doc
        .path(`M ${x} ${center - 3} A 3 3 0 0 0 ${x} ${center + 3} Z`)
        .fillColor(INK)
        .fill();
      doc.circle(x, center, 3).lineWidth(0.9).strokeColor(INK).stroke();
    }
    if (task.priority === 3) doc.circle(x, center, 3).lineWidth(0.9).strokeColor(INK).stroke();
  }

  try {
    masthead();
    planning();
    listing = true;
    gridTop = y;
    const entries = nestTasks(snapshot.tasks);
    const boxes = new Map<string, { page: number; x: number; bottom: number }>();
    entries.forEach(({ task, depth }, index) => {
      const boxX = LEFT + Math.min(depth, 3) * 16;
      const textX = boxX + 20;
      const textW = LEFT + TASK_W - 14 - textX;
      const caption = depth === 0 && task.parentTitle ? wrap(`↳ ${task.parentTitle}`, CAPTION, textW) : [];
      const title = wrap(task.title, TITLE, textW);
      const tagText = task.overdue ? runs("FORFALT", TAG) : undefined;
      const tagW = tagText ? tagText.width + 8 : 0;
      const info = details(task, snapshot.day);
      const meta = info ? wrap(info, META, textW - (tagW ? tagW + 5 : 0)) : tagText ? [runs("", META)] : [];
      const block = Math.max(
        MIN_BLOCK,
        PAD * 2 + caption.length * CAPTION_LH + title.length * TITLE_LH + (meta.length ? 2 + meta.length * META_LH : 0),
      );
      // Normal tasks stay intact. Oversized tasks continue at line boundaries.
      const keep = block <= BOTTOM - TOP - 22 - HEADING_H;
      if (task.projectId !== entries[index - 1]?.task.projectId) {
        let count = 0;
        while (entries[index + count]?.task.projectId === task.projectId) count++;
        project = undefined;
        reserve((fresh ? 0 : 14) + HEADING_H + (keep ? block : PAD + TITLE_LH));
        const top = fresh;
        if (!fresh) y += 14;
        project = { name: task.projectName, count };
        heading(task.projectName, count);
        // Notes dots start below the page's first heading, beside the first task.
        if (top) gridTop = y;
        fresh = true;
      } else reserve(keep ? block : PAD + TITLE_LH);
      if (!fresh) rule(boxX, RIGHT, y, 0.4, RULE);
      fresh = false;
      const start = y;
      const startPage = page();
      y += PAD;
      lines(caption, textX, CAPTION, CAPTION_LH);
      lines(title, textX, TITLE, TITLE_LH, (top) => {
        const strong = task.priority === 1;
        doc
          .roundedRect(boxX, top + 1, 12, 12, 2.5)
          .lineWidth(strong ? 1.8 : 1)
          .strokeColor(INK)
          .stroke();
        priority(task, top);
        boxes.set(task.id, { page: page(), x: boxX, bottom: top + 13 });
        const parent = task.parentId ? boxes.get(task.parentId) : undefined;
        if (depth > 0 && parent?.page === page()) {
          const x = parent.x + 6;
          const middle = top + 7;
          doc
            .lineWidth(0.6)
            .strokeColor(MUTED)
            .moveTo(x, parent.bottom + 2)
            .lineTo(x, middle)
            .lineTo(boxX - 2, middle)
            .stroke();
        }
      });
      if (meta.length) {
        y += 2;
        lines(meta, textX + (tagW ? tagW + 5 : 0), META, META_LH, (top) => {
          if (!tagText) return;
          const center = top + META_LH / 2;
          doc
            .roundedRect(textX, center - 4.6, tagW, 9.2, 2)
            .fillColor(INK)
            .fill();
          draw(tagText, textX + 4, center + 2.2, TAG);
        });
      }
      y += PAD;
      if (page() === startPage) y = Math.max(y, start + MIN_BLOCK);
    });
    closeGrid(y);
    listing = false;
    project = undefined;
    if (BOTTOM - y < 150) newPage();
    else y += 14;
    heading("Notater");
    dots(LEFT, RIGHT, y + 6, BOTTOM);

    const { count } = doc.bufferedPageRange();
    const footer: Style = { font: "body", size: 7.5, color: MUTED };
    const day = `${format(snapshot.day, { weekday: "long" })} ${short(snapshot.day)}`;
    for (let i = 0; i < count; i++) {
      doc.switchToPage(i);
      draw(runs(day, footer), LEFT, PAGE_H - 20, footer);
      const number = runs(`${i + 1} / ${count}`, footer);
      draw(number, RIGHT - number.width, PAGE_H - 20, footer);
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
