/* Norwegian command and action titles use sentence case. */
/* eslint-disable @raycast/prefer-title-case */
import {
  Action,
  ActionPanel,
  closeMainWindow,
  environment,
  getPreferenceValues,
  Keyboard,
  List,
  openCommandPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { basename, join } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  indexNotes,
  openNote,
  previewURL,
  readNotesCatalog,
  type NotesCatalog,
  type SkippedNote,
} from "./notes-bridge";
import { searchNotes, type NotesMode } from "./notes-search";

function message(error: unknown) {
  return error instanceof Error ? error.message : "Ukjent feil.";
}

function SkippedFiles({ items }: { items: SkippedNote[] }) {
  return (
    <List navigationTitle="Hoppet over ved indeksering">
      {items.map((item, i) => (
        <List.Item
          key={i}
          title={item.document}
          subtitle={item.reason}
          accessories={item.page ? [{ text: `Side ${item.page}` }] : []}
        />
      ))}
    </List>
  );
}

export default function SearchRemarkableNotes() {
  const root = getPreferenceValues<{ remarkableNotesPath: string }>()
    .remarkableNotesPath;
  const store = join(environment.supportPath, "remarkable-notes");
  const helper = join(environment.assetsPath, "remarkable-notes");
  const [loaded, setLoaded] = useState<{
    folder: string;
    catalog: NotesCatalog | null;
  } | null>(null);
  const catalog = loaded?.folder === root ? loaded.catalog : null;
  const opening = useRef(false);
  const [revision, setRevision] = useState(0),
    [reading, setReading] = useState(true);
  const [indexing, setIndexing] = useState(false),
    busy = useRef(false);
  const [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const [mode, setMode] = useState<NotesMode>("all");
  const [selection, setSelection] = useState<string | null>(null);
  const [image, setImage] = useState<{ id: string; url?: string } | null>(null);

  useEffect(() => {
    let active = true;
    setReading(true);
    setLoaded(null);
    setError("");
    void readNotesCatalog(root, store)
      .then((value) => {
        if (active) setLoaded({ folder: root, catalog: value });
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setReading(false);
      });
    return () => {
      active = false;
    };
  }, [root, store, revision]);

  const hits = useMemo(
    () => searchNotes(catalog?.entries ?? [], query, mode),
    [catalog, query, mode],
  );
  const selected = (hits.find((hit) => hit.entry.id === selection) ?? hits[0])
    ?.entry;
  useEffect(() => {
    let active = true;
    setImage(null);
    if (selected) {
      void previewURL(store, selected.preview)
        .then((url) => {
          if (active) setImage({ id: selected.id, url });
        })
        .catch(() => {
          if (active) setImage({ id: selected.id });
        });
    }
    return () => {
      active = false;
    };
  }, [selected, store]);

  async function updateIndex() {
    if (busy.current) return;
    busy.current = true;
    setIndexing(true);
    try {
      const report = await indexNotes(helper, root, store);
      setRevision((r) => r + 1);
      await showToast({
        style: Toast.Style.Success,
        title: "Indeks oppdatert",
        message: `${report.indexed} indeksert · ${report.unchanged} uendret · ${report.removed} fjernet · ${report.skipped.length} hoppet over`,
      });
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Kunne ikke oppdatere indeksen",
        message: message(e),
      });
    } finally {
      busy.current = false;
      setIndexing(false);
    }
  }
  async function openResult(id: string) {
    if (opening.current) return;
    opening.current = true;
    try {
      await openNote(helper, root, store, id);
      await closeMainWindow();
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Kunne ikke åpne siden",
        message: message(e),
      });
    } finally {
      opening.current = false;
    }
  }

  const common = (
    <>
      {!indexing && (
        <Action
          title="Oppdater indeks"
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={updateIndex}
        />
      )}
      {!!catalog?.skipped.length && (
        <Action.Push
          title="Vis hva som ble hoppet over"
          target={<SkippedFiles items={catalog.skipped} />}
        />
      )}
      <Action title="Velg importmappe" onAction={openCommandPreferences} />
    </>
  );
  const skipped = catalog?.skipped.length ?? 0;
  const status = indexing
    ? "Indekserer …"
    : skipped
      ? `${skipped} hoppet over · se handlingsmenyen`
      : "";
  const emptyTitle = reading
    ? "Leser indeks …"
    : error
      ? "Kunne ikke lese indeksen"
      : !catalog
        ? "Importmappen er ikke indeksert"
        : !catalog.entries.length
          ? "Ingen kommentarer i indeksen"
          : !query.trim()
            ? "Søk i notatene dine"
            : "Ingen treff";
  const emptyDescription =
    error ||
    status ||
    (!catalog
      ? "Velg Oppdater indeks (⌘R) for å lese PDF-ene i importmappen."
      : query.trim()
        ? "Prøv et annet ord, navn eller en emnekode."
        : "Skriv et ord, en frase eller en emnekode.");
  return (
    <List
      isShowingDetail
      filtering={false}
      isLoading={reading || indexing}
      navigationTitle="Søk i mine reMarkable-notater"
      searchText={query}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Søk etter ord, fraser eller emnekoder"
      onSelectionChange={setSelection}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Søk i"
          value={mode}
          onChange={(value) => setMode(value === "ink" ? "ink" : "all")}
        >
          <List.Dropdown.Item title="Håndskrift og avsnitt" value="all" />
          <List.Dropdown.Item title="Bare min håndskrift" value="ink" />
        </List.Dropdown>
      }
      actions={<ActionPanel>{common}</ActionPanel>}
    >
      <List.EmptyView title={emptyTitle} description={emptyDescription} />
      <List.Section title={`${hits.length} treff`} subtitle={status}>
        {hits.map((hit) => {
          const { entry } = hit;
          const source =
            hit.source === "ink" ? "I håndskriften" : "I avsnittet";
          const shownImage = image?.id === entry.id ? image : null;
          return (
            <List.Item
              key={entry.id}
              id={entry.id}
              title={hit.source === "ink" ? hit.text : entry.ink || hit.text}
              subtitle={`${basename(entry.document)} · s. ${entry.page}`}
              accessories={[
                { text: hit.uncertain ? `${source} · usikker` : source },
              ]}
              detail={
                <List.Item.Detail
                  isLoading={entry === selected && !shownImage}
                  markdown={
                    shownImage?.url
                      ? `![Kommentar med avsnitt](<${shownImage.url}>)`
                      : shownImage
                        ? "Utsnittet mangler. Oppdater indeksen."
                        : undefined
                  }
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label
                        title="Treff"
                        text={source}
                      />
                      <List.Item.Detail.Metadata.Label
                        title={
                          entry.uncertain || hit.uncertain
                            ? "Håndskrift (usikker lesning)"
                            : "Håndskrift"
                        }
                        text={entry.ink || "Ingen lesbar tekst"}
                      />
                      {!!entry.alternatives.length && (
                        <List.Item.Detail.Metadata.Label
                          title="Andre leseforslag"
                          text={entry.alternatives.join(" / ")}
                        />
                      )}
                      {!!entry.context && (
                        <List.Item.Detail.Metadata.Label
                          title="Avsnitt"
                          text={entry.context}
                        />
                      )}
                      <List.Item.Detail.Metadata.Label
                        title="Dokument"
                        text={entry.document}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="PDF-side"
                        text={String(entry.page)}
                      />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title="Åpne kommentert side"
                    onAction={() => openResult(entry.id)}
                  />
                  {common}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
