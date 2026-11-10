export type NoteEntry = {
  id: string;
  document: string;
  page: number;
  ink: string;
  alternatives: string[];
  uncertain: boolean;
  context: string;
  rect: number[];
  preview: string;
};
export type NotesMode = "all" | "ink";
export type NoteHit = {
  entry: NoteEntry;
  source: "ink" | "context";
  text: string;
  uncertain: boolean;
  phrase: boolean;
};

function words(text: string): string[] {
  return (
    text
      .normalize("NFC")
      .toLocaleLowerCase("nb-NO")
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  );
}

function compareHits(a: NoteHit, b: NoteHit): number {
  return (
    Number(a.uncertain) - Number(b.uncertain) ||
    Number(a.source === "context") - Number(b.source === "context") ||
    Number(b.phrase) - Number(a.phrase)
  );
}

/** All query words must occur in the same reading or in the same adjacent paragraph. */
export function searchNotes(
  entries: NoteEntry[],
  query: string,
  mode: NotesMode = "all",
): NoteHit[] {
  const terms = words(query);
  if (!terms.length) return [];
  const phrase = " " + terms.join(" ") + " ";
  const hits: NoteHit[] = [];
  for (const entry of entries) {
    const candidates: NoteHit[] = [];
    const match = (
      text: string,
      source: NoteHit["source"],
      uncertain: boolean,
    ) => {
      const tokens = words(text);
      if (!terms.every((term) => tokens.includes(term))) return;
      candidates.push({
        entry,
        source,
        text,
        uncertain,
        phrase: (" " + tokens.join(" ") + " ").includes(phrase),
      });
    };
    match(entry.ink, "ink", entry.uncertain);
    for (const alternative of entry.alternatives)
      match(alternative, "ink", true);
    if (mode === "all") match(entry.context, "context", false);
    const best = candidates.sort(compareHits)[0];
    if (best) hits.push(best);
  }
  return hits.sort(
    (a, b) =>
      compareHits(a, b) ||
      a.entry.document.localeCompare(b.entry.document, "nb", {
        numeric: true,
      }) ||
      a.entry.page - b.entry.page ||
      a.entry.id.localeCompare(b.entry.id),
  );
}
