import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type { NotesCatalog } from "../src/notes-bridge";
import { searchNotes, type NotesMode } from "../src/notes-search";

const bridge = vi.hoisted(() => ({
  readNotesCatalog: vi.fn(),
  previewURL: vi.fn(),
  indexNotes: vi.fn(),
  openNote: vi.fn(),
}));
vi.mock("../src/notes-bridge", () => bridge);
vi.mock("@raycast/api", () => {
  const host = (type: string) => (p: Record<string, unknown>) =>
    React.createElement(
      type,
      p,
      p.searchBarAccessory as React.ReactNode,
      p.children as React.ReactNode,
    );
  const Detail = Object.assign(host("detail"), {
    Metadata: Object.assign(host("metadata"), { Label: host("label") }),
  });
  return {
    Action: Object.assign(host("action"), { Push: host("push") }),
    ActionPanel: host("actions"),
    List: Object.assign(host("list"), {
      Section: host("section"),
      Item: Object.assign(host("item"), { Detail }),
      EmptyView: host("empty"),
      Dropdown: Object.assign(host("dropdown"), { Item: host("option") }),
    }),
    environment: { assetsPath: "/assets", supportPath: "/support" },
    getPreferenceValues: () => ({ remarkableNotesPath: "/input" }),
    Keyboard: {
      Shortcut: { Common: { Refresh: { modifiers: ["cmd"], key: "r" } } },
    },
    Toast: { Style: { Success: "success", Failure: "failure" } },
    closeMainWindow: vi.fn(),
    openCommandPreferences: vi.fn(),
    showToast: vi.fn(),
  };
});
import SearchRemarkableNotes from "../src/search-remarkable-notes";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer;
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  vi.resetAllMocks();
});
async function render(catalog: NotesCatalog) {
  bridge.readNotesCatalog.mockResolvedValue(catalog);
  await act(async () => {
    view = create(<SearchRemarkableNotes />);
  });
}
async function input(query: string, mode: NotesMode) {
  await act(async () => {
    view.root.findByType("dropdown").props.onChange(mode);
    view.root.findByType("list").props.onSearchTextChange(query);
  });
}
const rows = () => view.root.findAllByType("item");

it("viser begge kilder før filtrering, og søk og filter starter ingen ny indeksering", async () => {
  const common = {
    page: 1,
    rect: [0, 0, 20, 40],
    preview: "p.png",
    document: "Kommenterte/emne.pdf",
    alternatives: [],
    uncertain: false,
  };
  bridge.previewURL.mockResolvedValue("file:///indeks/utsnitt.png");
  await render({
    version: 1,
    root: "/input",
    skipped: [],
    entries: [
      { ...common, id: "a", ink: "Ekstern sensor", context: "" },
      { ...common, id: "b", ink: "Kontroller", context: "Ekstern sensor" },
    ],
  });
  expect(view.root.findByType("dropdown").props.value).toBe("all");
  await input("ekstern sensor", "all");
  expect(rows().map((x) => [x.props.id, x.props.accessories[0].text])).toEqual([
    ["a", "I håndskriften"],
    ["b", "I avsnittet"],
  ]);
  expect(rows()[0].props.detail.props.markdown).toContain(
    "file:///indeks/utsnitt.png",
  );
  await input("ekstern sensor", "ink");
  expect(rows().map((x) => x.props.id)).toEqual(["a"]);
  const primary = React.Children.toArray(
    rows()[0].props.actions.props.children,
  )[0] as React.ReactElement<{ onAction: () => void }>;
  await act(async () => {
    await primary.props.onAction();
  });
  expect(bridge.openNote).toHaveBeenCalledWith(
    "/assets/remarkable-notes",
    "/input",
    "/support/remarkable-notes",
    "a",
  );
  expect(bridge.readNotesCatalog).toHaveBeenCalledTimes(1);
  expect(bridge.indexNotes).not.toHaveBeenCalled();
});

const goldPath = process.env.NOTES_PILOT_GOLD,
  catalogPath = process.env.NOTES_PILOT_CATALOG;
it.skipIf(!goldPath || !catalogPath)(
  "pilot: input til rangert liste og første utsnitt",
  async () => {
    const catalog: NotesCatalog = JSON.parse(
      await readFile(catalogPath!, "utf8"),
    );
    const gold: { queries: { query: string; mode?: NotesMode }[] } = JSON.parse(
      await readFile(goldPath!, "utf8"),
    );
    const actual = await vi.importActual<typeof import("../src/notes-bridge")>(
      "../src/notes-bridge",
    );
    bridge.previewURL.mockImplementation((_store: string, relative: string) =>
      actual.previewURL(dirname(catalogPath!), relative),
    );
    await render(catalog);
    const times: number[] = [];
    for (const { query, mode = "all" } of gold.queries) {
      await input("", mode);
      const wanted = searchNotes(catalog.entries, query, mode).map(
        (h) => h.entry.id,
      );
      const start = performance.now();
      await input(query, mode);
      expect(rows().map((r) => r.props.id)).toEqual(wanted);
      if (wanted.length) {
        while (
          !rows()[0].props.detail.props.markdown &&
          performance.now() - start < 1200
        ) {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 3));
          });
        }
        expect(rows()[0].props.detail.props.markdown).toContain("file:");
      }
      times.push(performance.now() - start);
    }
    const p95 = times.sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];
    console.info(
      `Hodeløs Raycast-komponent: ${times.length} pilotsøk, p95 ${Math.round(p95)} ms (rangert liste og oppløst lokal bildeadresse).`,
    );
    expect(p95).toBeLessThanOrEqual(1000);
  },
  60_000,
);
