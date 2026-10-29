/* eslint-disable @raycast/prefer-title-case */
import {
  Action,
  ActionPanel,
  Form,
  List,
  Keyboard,
  getPreferenceValues,
  useNavigation,
} from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Services,
  catalog,
  fulltext,
  getJson,
  pdfUrl,
  markdown,
  type Catalog,
  type Entry,
  type Fulltext,
} from "./service";
import { findEntries, indexEntries } from "./library-search";
const empty: Fulltext = { status: "missing", matches: {} };
type Filters = { year: string; tags: string[]; text: boolean };
function FiltersForm({
  data,
  value,
  onApply,
}: {
  data: Catalog;
  value: Filters;
  onApply: (v: Filters) => void;
}) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle="Filtrer masteroppgaver"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Bruk filtre"
            onSubmit={(v: Filters) => {
              onApply(v);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="year" title="År" defaultValue={value.year}>
        <Form.Dropdown.Item value="" title="Alle år" />
        {[...new Set(data.entries.map((e) => e.year))]
          .sort((a, b) => b - a)
          .map((y) => (
            <Form.Dropdown.Item key={y} value={String(y)} title={String(y)} />
          ))}
      </Form.Dropdown>
      <Form.TagPicker
        id="tags"
        title="Alle valgte temaer"
        defaultValue={value.tags}
      >
        {data.topics.map((t) => (
          <Form.TagPicker.Item key={t.id} value={t.id} title={t.label} />
        ))}
      </Form.TagPicker>
      <Form.Checkbox
        id="text"
        label="Søk også i PDF-tekst"
        defaultValue={value.text}
      />
    </Form>
  );
}
export default function SearchTheses() {
  const service = useMemo(() => new Services(getPreferenceValues()), []);
  const { push } = useNavigation();
  const [data, setData] = useState<Catalog>({ entries: [], topics: [] }),
    [base, setBase] = useState(""),
    [q, rawSetQ] = useState(""),
    [filters, setFilters] = useState<Filters>({
      year: "",
      tags: [],
      text: true,
    }),
    [hits, setHits] = useState(empty),
    [status, setStatus] = useState("Starter biblioteket …"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [limit, setLimit] = useState(50);
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const setQ = (value: string) => {
    generation.current++;
    request.current?.abort();
    setHits(empty);
    rawSetQ(value);
  };
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError("");
    void service
      .connect("library", revision > 0)
      .then(async (s) => {
        const d = catalog(await getJson(`${s.baseUrl}/api/catalog`, c.signal));
        if (!c.signal.aborted) {
          setData(d);
          setBase(s.baseUrl);
        }
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError(
            "Kunne ikke hente biblioteket. Kontroller innstillinger og lokalt oppsett.",
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [service, revision]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    setHits(empty);
    setLimit(50);
    const timer = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => {
    const n = ++generation.current,
      c = new AbortController();
    request.current = c;
    setHits(empty);
    setLimit(50);
    if (!base) return;
    if (!filters.text) {
      setStatus("Søker bare i katalogen.");
      return;
    }
    setStatus("Søker i PDF-tekst … Katalogtreff vises allerede.");
    void getJson(
      `${base}/api/fulltext?q=${encodeURIComponent(query)}`,
      c.signal,
    )
      .then((v) => {
        if (n !== generation.current || c.signal.aborted) return;
        const f = fulltext(v);
        setHits(f);
        setStatus(
          f.status === "ready"
            ? "PDF-søk er tilgjengelig."
            : "PDF-indeks mangler eller er utilgjengelig. Katalogsøk fungerer.",
        );
      })
      .catch(() => {
        if (!c.signal.aborted)
          setStatus("PDF-søk er utilgjengelig. Katalogsøk fungerer.");
      });
    return () => c.abort();
  }, [query, filters, base, revision]);
  const indexed = useMemo(
    () => indexEntries(data.entries, data.topics),
    [data],
  );
  const found = findEntries(
    indexed,
    { q: query, year: filters.year, tags: filters.tags },
    hits.matches,
  );
  const refresh = (
    <Action
      title="Hent oppdaterte data"
      shortcut={Keyboard.Shortcut.Common.Refresh}
      onAction={() => setRevision((r) => r + 1)}
    />
  );
  const filter = (
    <Action
      title="Filtrer"
      shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
      onAction={() =>
        push(<FiltersForm data={data} value={filters} onApply={setFilters} />)
      }
    />
  );
  return (
    <List
      filtering={false}
      isShowingDetail
      isLoading={loading}
      searchText={q}
      onSearchTextChange={setQ}
      searchBarPlaceholder="Tittel, forfatter, tema eller PDF-tekst"
      navigationTitle="Søk i masteroppgaver"
      pagination={{
        pageSize: 50,
        hasMore: limit < found.length,
        onLoadMore: () => setLimit((n) => n + 50),
      }}
      actions={
        <ActionPanel>
          {refresh}
          {filter}
        </ActionPanel>
      }
    >
      <List.EmptyView
        title={error || (loading ? "Starter biblioteket …" : "Ingen treff")}
        description={status}
      />
      <List.Section title={`${found.length} treff`} subtitle={status}>
        {found.slice(0, limit).map((e) => {
          const snippets = (hits.matches[e.id]?.snippets || [])
            .filter((s) =>
              e.files.some(
                (f) => f.path === s.path && s.page >= 1 && s.page <= f.pages,
              ),
            )
            .slice(0, 3);
          const file = snippets[0]
            ? e.files.find((f) => f.path === snippets[0].path)
            : e.files[0];
          const library = `${base}/?id=${encodeURIComponent(e.id)}`;
          const pdf = (f: Entry["files"][number], page?: number) => {
            try {
              return pdfUrl(base, e, f, page);
            } catch {
              return undefined;
            }
          };
          const primary = file ? pdf(file, snippets[0]?.page) : undefined;
          return (
            <List.Item
              key={e.id}
              title={e.title}
              subtitle={`${e.authors.join(" · ")} · ${e.year}`}
              accessories={[{ text: e.files.length ? "PDF" : "Mangler PDF" }]}
              keywords={e.authors}
              detail={
                <List.Item.Detail
                  markdown={`# ${markdown(e.title)}\n\n${markdown(e.authors.join(" · "))} · ${e.year}\n\n${markdown(e.abstract || "Sammendrag er ikke registrert.")}\n\n${snippets.map((s) => `**PDF-side ${s.page}**\n\n${markdown(s.text)}`).join("\n\n")}`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label
                        title="PDF"
                        text={
                          e.files.length
                            ? `${e.files.length} lokal(e) fil(er)`
                            : "Mangler lokal PDF"
                        }
                      />
                      <List.Item.Detail.Metadata.Label
                        title="Tema"
                        text={
                          data.topics
                            .filter((t) => e.tags.includes(t.id))
                            .map((t) => t.label)
                            .join(", ") || "Ingen temaer"
                        }
                      />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  {primary && (
                    <Action.OpenInBrowser title="Les PDF" url={primary} />
                  )}
                  <Action.OpenInBrowser
                    title="Åpne i biblioteket"
                    url={library}
                  />
                  {snippets.map((s, i) => {
                    const f = e.files.find((f) => f.path === s.path)!;
                    const url = pdf(f, s.page);
                    return (
                      url && (
                        <Action.OpenInBrowser
                          key={i}
                          title={`Åpne PDF-treff på side ${s.page}`}
                          url={url}
                        />
                      )
                    );
                  })}
                  {e.files.map((f, i) => {
                    const url = pdf(f);
                    return (
                      url && (
                        <Action.OpenInBrowser
                          key={f.path}
                          title={`Åpne PDF-variant ${i + 1}`}
                          url={url}
                        />
                      )
                    );
                  })}
                  {filter}
                  {refresh}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
