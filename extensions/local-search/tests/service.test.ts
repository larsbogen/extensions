import { it, expect, vi, afterEach } from "vitest";
import {
  localUrl,
  pdfUrl,
  Services,
  fulltext,
  catalog,
  tours,
  getJson,
} from "../src/service";
import { indexEntries, findEntries, normalize } from "../src/library-search";
const entry = (id: string, title: string, year: number, extra = {}) => ({
  id,
  title,
  year,
  authors: ["Åse Ødegård"],
  supervisors: [],
  keywords: [],
  abstract: "",
  tags: [],
  files: [],
  ...extra,
});
const entries = indexEntries(
  [
    entry("a", "Sørlandets kommuner", 2024, { tags: ["lead", "digital"] }),
    entry("b", "Digitalisering", 2026, {
      authors: ["Bjørn"],
      abstract: "Sørlandets kommuner",
      tags: ["lead"],
    }),
    entry("c", "Ledelse", 2006),
  ],
  [{ id: "digital", label: "Digitalisering" }],
);
afterEach(() => vi.restoreAllMocks());
it("normaliserer norsk og rangerer metadata som biblioteket", () => {
  expect(normalize("Æ Ø Å É")).toBe("ae o a e");
  expect(
    findEntries(entries, { q: "sorlandets kommuner" }).map((e) => e.id),
  ).toEqual(["a", "b"]);
});
it("kombinerer alle ord på tvers av metadata og PDF", () => {
  const hits = { a: { terms: ["zebra"], snippets: [] } };
  expect(
    findEntries(entries, { q: "ase zebra" }, hits).map((e) => e.id),
  ).toEqual(["a"]);
  expect(findEntries(entries, { q: "ase zebra absent" }, hits)).toEqual([]);
});
it("kombinerer år og alle temaer, tomt søk er nyest", () => {
  expect(
    findEntries(entries, { tags: ["lead", "digital"], year: "2024" }).map(
      (e) => e.id,
    ),
  ).toEqual(["a"]);
  expect(findEntries(entries, {}).map((e) => e.id)).toEqual(["b", "a", "c"]);
});
it("avviser fremmede adresser", () => {
  for (const u of [
    "https://example.com",
    "http://localhost:1",
    "http://127.0.0.1",
    "http://127.0.0.1:1/?q=a",
    "http://user@127.0.0.1:1",
  ])
    expect(() => localUrl(u)).toThrow();
});
it("validerer PDF-variant og fysisk side", () => {
  const e = entry("a", "A", 2026, {
    files: [{ path: "pdf/a b.pdf", pages: 20 }],
  });
  expect(pdfUrl("http://127.0.0.1:8766", e, e.files[0], 3)).toBe(
    "http://127.0.0.1:8766/pdf/a%20b.pdf#page=3",
  );
  expect(() => pdfUrl("http://127.0.0.1:8766", e, e.files[0], 21)).toThrow();
  expect(() =>
    pdfUrl("http://127.0.0.1:8766", e, { path: "pdf/../secret.pdf", pages: 2 }),
  ).toThrow();
});
it("validerer svar og manglende indeks", () => {
  expect(catalog({ entries, topics: [] })).toBeTruthy();
  expect(fulltext({ status: "missing", matches: {} }).matches).toEqual({});
  expect(() => catalog({ entries: [{ id: "bad" }], topics: [] })).toThrow();
  expect(() => tours({ version: 2, total: 0, items: [], kinds: [] })).toThrow();
});
it("fornyer søkenøkkel én gang ved 401", async () => {
  const s = new Services({});
  const connect = vi
    .spyOn(s, "connect")
    .mockResolvedValue({ baseUrl: "http://127.0.0.1:4317", token: "secret" });
  const f = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("", { status: 401 }))
    .mockResolvedValueOnce(
      Response.json({ version: 1, total: 0, items: [], kinds: [] }),
    );
  expect((await s.searchAtlas(new URLSearchParams())).data.total).toBe(0);
  expect(connect).toHaveBeenCalledWith("atlas", true);
  expect(f).toHaveBeenCalledTimes(2);
});
it("gjentar ikke ubegrenset ved feil nøkkel", async () => {
  const s = new Services({});
  vi.spyOn(s, "connect").mockResolvedValue({
    baseUrl: "http://127.0.0.1:4317",
    token: "secret",
  });
  const f = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("", { status: 401 }));
  await expect(s.searchAtlas(new URLSearchParams())).rejects.toThrow();
  expect(f).toHaveBeenCalledTimes(2);
});
it("bruker avbrytbare forespørsler og avviser redirect", async () => {
  const f = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_u, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeTruthy();
      return Response.json({});
    });
  await getJson("http://127.0.0.1:1");
  expect(f).toHaveBeenCalledOnce();
});
