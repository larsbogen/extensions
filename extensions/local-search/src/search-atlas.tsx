/* eslint-disable @raycast/prefer-title-case */
import {
  Action,
  ActionPanel,
  Form,
  List,
  Keyboard,
  getPreferenceValues,
  open,
  useNavigation,
} from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { Services, markdown, type Tour } from "./service";
type Filters = { kind: string; from: string; to: string };
function FilterForm({
  value,
  kinds,
  apply,
}: {
  value: Filters;
  kinds: string[];
  apply: (v: Filters) => void;
}) {
  const { pop } = useNavigation();
  const [error, setError] = useState("");
  return (
    <Form
      navigationTitle="Filtrer turer"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Bruk filtre"
            onSubmit={(v: Filters) => {
              if (
                (v.from && !validDate(v.from)) ||
                (v.to && !validDate(v.to)) ||
                (v.from && v.to && v.from > v.to)
              ) {
                setError("Bruk gyldige datoer som ÅÅÅÅ-MM-DD, fra før til.");
                return;
              }
              apply(v);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="kind" title="Aktivitetstype" defaultValue={value.kind}>
        <Form.Dropdown.Item title="Alle typer" value="" />
        {kinds.map((k) => (
          <Form.Dropdown.Item key={k} value={k} title={k} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="from"
        title="Fra dato"
        placeholder="ÅÅÅÅ-MM-DD"
        defaultValue={value.from}
        error={error}
      />
      <Form.TextField
        id="to"
        title="Til dato"
        placeholder="ÅÅÅÅ-MM-DD"
        defaultValue={value.to}
      />
    </Form>
  );
}
export function validDate(s: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s
  );
}
const metric = (n: number | null, unit: string, divisor = 1) =>
  n === null
    ? "Ukjent"
    : `${(n / divisor).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} ${unit}`;
export default function SearchAtlas() {
  const epoch = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const services = useMemo(() => new Services(getPreferenceValues()), []),
    { push } = useNavigation();
  const [q, rawSetQ] = useState(""),
    [query, setQuery] = useState(""),
    [filters, setFilters] = useState<Filters>({ kind: "", from: "", to: "" }),
    [items, setItems] = useState<Tour[]>([]),
    [total, setTotal] = useState(0),
    [kinds, setKinds] = useState<string[]>([]),
    [base, setBase] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [limit, setLimit] = useState(50),
    [revision, setRevision] = useState(0);
  const setQ = (value: string) => {
    epoch.current++;
    request.current?.abort();
    setItems([]);
    setTotal(0);
    setLoading(true);
    rawSetQ(value);
  };
  useEffect(() => {
    setItems([]);
    setLimit(50);
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const n = ++epoch.current,
      c = new AbortController();
    request.current = c;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      ...filters,
      q: query,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: "0",
      limit: "50",
    });
    void (async () => {
      if (c.signal.aborted) return;
      const result = await services.searchAtlas(params, c.signal);
      if (c.signal.aborted || epoch.current !== n) return;
      setItems(result.data.items);
      setTotal(result.data.total);
      setKinds(result.data.kinds);
      setBase(result.baseUrl);
      setLimit(50);
    })()
      .catch(() => {
        if (!c.signal.aborted && epoch.current === n) {
          setItems([]);
          setTotal(0);
          setError(
            "Kunne ikke hente turer. Kontroller prosjektmappe og oppsett. En eldre server må støtte lokalt søk.",
          );
        }
      })
      .finally(() => {
        if (!c.signal.aborted && epoch.current === n) setLoading(false);
      });
    return () => c.abort();
  }, [services, query, filters, revision]);
  const filter = (
    <Action
      title="Filtrer"
      shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
      onAction={() =>
        push(
          <FilterForm
            value={filters}
            kinds={kinds}
            apply={(v) => {
              epoch.current++;
              setItems([]);
              setFilters(v);
            }}
          />,
        )
      }
    />
  );
  const refresh = (
    <Action
      title="Hent oppdaterte data"
      shortcut={Keyboard.Shortcut.Common.Refresh}
      onAction={() => {
        epoch.current++;
        request.current?.abort();
        setItems([]);
        setTotal(0);
        setRevision((r) => r + 1);
      }}
    />
  );
  const extras = (
    <>
      <Action
        title="Åpne siste tur"
        onAction={async () => {
          try {
            const r = await services.searchAtlas(
              new URLSearchParams({
                limit: "1",
                dated: "true",
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              }),
            );
            if (r.data.items[0])
              await open(
                `${r.baseUrl}/?activity=${encodeURIComponent(r.data.items[0].id)}`,
              );
            else setError("Ingen daterte turer.");
          } catch {
            setError("Kunne ikke hente siste tur.");
          }
        }}
      />
      {base && (
        <Action.OpenInBrowser
          title="Åpne importoversikten"
          url={`${base}/?view=imports`}
        />
      )}
    </>
  );
  async function loadMore() {
    if (loading || items.length >= total) return;
    setLoading(true);
    const n = epoch.current;
    try {
      const r = await services.searchAtlas(
        new URLSearchParams({
          ...filters,
          q: query,
          offset: String(items.length),
          limit: "50",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      );
      if (n === epoch.current) {
        setItems((old) => [
          ...old,
          ...r.data.items.filter((a) => !old.some((b) => a.id === b.id)),
        ]);
        setLimit(limit + 50);
      }
    } catch {
      if (n === epoch.current)
        setError("Kunne ikke hente flere treff. Prøv å oppdatere.");
    } finally {
      if (n === epoch.current) setLoading(false);
    }
  }
  return (
    <List
      filtering={false}
      isShowingDetail
      isLoading={loading}
      navigationTitle="Søk i Turatlas"
      searchText={q}
      onSearchTextChange={setQ}
      searchBarPlaceholder="Tittel, stedsnavn i tekst, aktivitet eller dato"
      pagination={{
        pageSize: 50,
        hasMore: items.length < total,
        onLoadMore: loadMore,
      }}
      actions={
        <ActionPanel>
          {filter}
          {refresh}
          {extras}
        </ActionPanel>
      }
    >
      <List.EmptyView
        title={error || (loading ? "Starter Turatlas …" : "Ingen treff")}
        description="Søker i eksisterende titler og notater."
      />
      <List.Section title={`${total} treff`}>
        {items.map((a) => (
          <List.Item
            key={a.id}
            title={a.title}
            subtitle={`${a.day || "Ukjent dato"} · ${a.kind}`}
            accessories={[{ text: metric(a.distance, "km", 1000) }]}
            detail={
              <List.Item.Detail
                markdown={`# ${markdown(a.title)}\n\n${a.day || "Ukjent dato"} · ${markdown(a.kind)}\n\nDistanse: ${metric(a.distance, "km", 1000)}\n\nVarighet: ${metric(a.duration, "min", 60)}\n\nSpor: ${markdown(a.routeStatus)} · ${a.mediaCount} bilder\n\n${markdown(a.snippet || "")}`}
              />
            }
            actions={
              <ActionPanel>
                <Action.OpenInBrowser
                  title="Åpne turen"
                  url={`${base}/?activity=${encodeURIComponent(a.id)}`}
                />
                {filter}
                {refresh}
                {extras}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
