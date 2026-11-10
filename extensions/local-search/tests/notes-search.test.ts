import { describe, expect, it } from "vitest";
import { searchNotes, type NoteEntry } from "../src/notes-search";

const entry = (
  id: string,
  ink: string,
  context = "",
  extras: Partial<NoteEntry> = {},
): NoteEntry => ({
  id,
  ink,
  context,
  document: "Annoterte/emne.pdf",
  page: 2,
  alternatives: [],
  uncertain: false,
  rect: [1, 2, 10, 25],
  preview: `images/${id}.png`,
  ...extras,
});
describe("lokalt søk i kommentarutsnitt", () => {
  it("rangerer håndskrift foran trykt tekst og fraser foran spredte ord innen samme kilde", () => {
    const entries = [
      entry("print", "Sjekk neste møte", "Ekstern sensor oppnevnes"),
      entry("split", "Sensor er ekstern."),
      entry("phrase", "Spør ekstern sensor!"),
      entry("mixed", "Ekstern", "Sensor oppnevnes"),
      entry("alternatives", "Se møte", "", {
        alternatives: ["Ekstern", "Sensor"],
      }),
    ];
    expect(
      searchNotes(entries, "ekstern sensor").map((h) => [
        h.entry.id,
        h.source,
        h.phrase,
      ]),
    ).toEqual([
      ["phrase", "ink", true],
      ["split", "ink", false],
      ["print", "context", true],
    ]);
    expect(
      searchNotes(entries, "ekstern sensor", "ink").map((h) => h.entry.id),
    ).toEqual(["phrase", "split"]);
  });
  it("holder nesten like emnekoder fra hverandre og viser usikre forslag bare som usikre treff", () => {
    const entries = [
      entry("diff", "MUR107", "", {
        alternatives: ["MUR101"],
        uncertain: true,
      }),
      entry("exact", "MUR101"),
      entry("long", "MUR1010 MUR101A"),
      entry("context", "MUR107", "MUR101", {
        alternatives: ["MUR101"],
        uncertain: true,
      }),
    ];
    expect(
      searchNotes(entries, "mur101").map((h) => [
        h.entry.id,
        h.source,
        h.uncertain,
      ]),
    ).toEqual([
      ["exact", "ink", false],
      ["context", "context", false],
      ["diff", "ink", true],
    ]);
    expect(searchNotes(entries, "MUR10")).toEqual([]);
    expect(searchNotes(entries, "MUR102")).toEqual([]);
  });
  it("bevarer norske bokstaver og finner Unicode-normalisert tekst", () => {
    const entries = [
      entry("a", "Må – avklares før neste kull"),
      entry("b", "Ma avklares"),
    ];
    expect(
      searchNotes(entries, "MA\u030A AVKLARES").map((h) => h.entry.id),
    ).toEqual(["a"]);
    expect(searchNotes(entries, "---")).toEqual([]);
  });
});
