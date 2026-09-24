/* Norwegian action titles preserve product spelling. */
/* eslint-disable @raycast/prefer-title-case */
import {
  Action,
  ActionPanel,
  Color,
  Detail,
  environment,
  getPreferenceValues,
  Icon,
  List,
  LocalStorage,
  open,
  openCommandPreferences,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import path from "node:path";
import { initialSync } from "./api";
import { withTodoistApi } from "./helpers/withTodoistApi";
import { createPlanPdf } from "./remarkable/pdf";
import { createSnapshot, dailyTasks, type PlanTask } from "./remarkable/plan";
import {
  DailyPlanService,
  type ExportJob,
  type Folder,
  type JobState,
  type ToolPreferences,
} from "./remarkable/service";

const FOLDER_KEY = "remarkable-daily-plan-folder-v1";
const STATE_LABELS: Record<JobState, string> = {
  exporting: "Lager PDF …",
  validating: "Validerer alle PDF-sider …",
  ready: "Forhåndsvisning klar",
  sending: "Sender til reMarkable …",
  sent: "Sendt til reMarkable",
  uncertain: "Sending ikke bekreftet",
  error: "Eksport mislyktes",
};
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Operasjonen mislyktes.");

function FolderPicker({
  service,
  onChoose,
}: {
  service: DailyPlanService;
  onChoose: (folder: Folder) => Promise<void>;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { pop } = useNavigation();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setFolders([]);
    try {
      setFolders(await service.folders());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [service]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <List
      isLoading={loading}
      navigationTitle="Velg mappe på reMarkable"
      searchBarPlaceholder="Finn Dagsplaner eller en annen mappe"
    >
      <List.EmptyView
        title={error ? "Kunne ikke hente mapper" : "Ingen mapper funnet"}
        description={error || "Opprett Dagsplaner i reMarkable-appen, og oppdater listen."}
        actions={
          <ActionPanel>
            <Action title="Hent Mapper På Nytt" icon={Icon.ArrowClockwise} onAction={load} />
            <Action.CopyToClipboard title="Kopier Kommando for Mappeinnlogging" content="rm2 cloud web-login" />
            <Action title="Åpne Innstillinger" onAction={openCommandPreferences} />
          </ActionPanel>
        }
      />
      {folders.map((folder) => (
        <List.Item
          key={folder.id}
          title={folder.name}
          subtitle={folder.id.slice(-8)}
          icon={Icon.Folder}
          actions={
            <ActionPanel>
              <Action
                title="Bruk Denne Mappen"
                onAction={async () => {
                  await onChoose(folder);
                  pop();
                }}
              />
              <Action title="Oppdater Mapper" onAction={load} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

export function DailyPlanCommand() {
  const prefs = getPreferenceValues<ToolPreferences>();
  const service = useMemo(
    () =>
      new DailyPlanService(path.join(environment.supportPath, "daily-plans"), prefs, (snapshot, output) =>
        createPlanPdf(snapshot, output, path.join(environment.assetsPath, "daily-plan", "NotoEmoji.ttf")),
      ),
    [prefs.rm2Path, prefs.pdfinfoPath, prefs.pdftoppmPath],
  );
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folder, setFolder] = useState<Folder>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<JobState>();
  const [job, setJob] = useState<ExportJob>();
  const [latest, setLatest] = useState<ExportJob>();
  const [previewOpened, setPreviewOpened] = useState(false);
  const [search, setSearch] = useState("");
  const busy = useRef(false);

  const fetchFresh = useCallback(async () => {
    const data = await initialSync(["user", "projects", "items"]);
    if (!data.user?.id || !Array.isArray(data.items) || !Array.isArray(data.projects))
      throw new Error("Todoist returnerte ufullstendige data.");
    return dailyTasks(data.items, data.projects, data.user.id);
  }, []);
  const reload = useCallback(async () => {
    if (busy.current) return;
    setLoading(true);
    setError("");
    setTasks([]);
    setSelected(new Set());
    setJob(undefined);
    setPreviewOpened(false);
    try {
      const fresh = await fetchFresh();
      setTasks(fresh);
      setSelected(new Set(fresh.map((t) => t.id)));
    } catch {
      setError("Kunne ikke hente ferske oppgaver fra Todoist. Kontroller tilkobling og innlogging, og prøv igjen.");
    } finally {
      setLoading(false);
    }
  }, [fetchFresh]);
  useEffect(() => {
    void reload();
    void LocalStorage.getItem<string>(FOLDER_KEY).then((raw) => {
      if (raw) {
        try {
          const stored = JSON.parse(raw);
          if (typeof stored.id === "string" && typeof stored.name === "string") setFolder(stored);
        } catch {
          /* choose again */
        }
      }
    });
    void service
      .latest()
      .then(setLatest)
      .catch(() => {});
  }, [reload, service]);
  const chooseFolder = async (value: Folder) => {
    await LocalStorage.setItem(FOLDER_KEY, JSON.stringify(value));
    setFolder(value);
    setJob(undefined);
    setPreviewOpened(false);
  };
  const changeSelection = (value: Set<string>) => {
    if (!busy.current) {
      setSelected(value);
      setJob(undefined);
      setPreviewOpened(false);
    }
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    changeSelection(next);
  };
  async function openPreview(value: ExportJob) {
    try {
      await open(service.pdfPath(value));
      setPreviewOpened(true);
    } catch {
      setPreviewOpened(false);
      await showToast({
        style: Toast.Style.Failure,
        title: "Kunne ikke åpne PDF",
        message: "Velg Åpne forhåndsvisning for å prøve igjen.",
      });
    }
  }
  async function preview() {
    if (busy.current || !folder || selected.size === 0 || loading || error) return;
    busy.current = true;
    setStage(undefined);
    setLoading(true);
    setError("");
    try {
      const fresh = await fetchFresh();
      setTasks(fresh);
      const kept = new Set(fresh.filter((t) => selected.has(t.id)).map((t) => t.id));
      setSelected(kept);
      const snapshot = createSnapshot(fresh, kept);
      const exported = await service.export(snapshot, folder, setStage);
      setJob(exported);
      setLatest(exported);
      await openPreview(exported);
    } catch (e) {
      setStage("error");
      await showToast({ style: Toast.Style.Failure, title: "Kunne ikke lage dagsplan", message: errorMessage(e) });
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }
  async function send() {
    if (busy.current || !job || !previewOpened || job.state !== "ready") return;
    busy.current = true;
    setStage("sending");
    try {
      const result = await service.send(job.id);
      setJob(result);
      setLatest(result);
      setStage(result.state);
      await showToast({
        style: result.state === "sent" ? Toast.Style.Success : Toast.Style.Failure,
        title: result.error ? "Sending stoppet" : STATE_LABELS[result.state],
        message: result.documentId ?? result.error,
      });
    } catch (e) {
      // A durable "sending" state is also treated as uncertain after interruption.
      const saved = await service.load(job.id).catch(() => undefined);
      if (saved) {
        setJob(saved);
        setStage(saved.state);
      } else {
        setStage("error");
      }
      await showToast({ style: Toast.Style.Failure, title: "Sending stoppet", message: errorMessage(e) });
    } finally {
      busy.current = false;
    }
  }
  if (job) {
    const active = stage === "sending" && busy.current;
    const uncertain = job.state === "uncertain" || (job.state === "sending" && !active);
    const title = active ? STATE_LABELS.sending : uncertain ? "Sending ikke bekreftet" : STATE_LABELS[job.state];
    const summary = [
      `# ${title}`,
      "",
      job.snapshot.name,
      "",
      `**${job.snapshot.tasks.length} oppgaver · ${job.pages} sider**`,
      "",
      `Mappe: ${job.folder.name}`,
      "",
      "PDF-en er et frosset øyeblikksbilde. Avkrysninger og notater synkroniseres ikke til Todoist.",
      ...(job.documentId ? ["", `Dokument-ID: \`${job.documentId}\``] : []),
      ...(uncertain
        ? ["", "Kontroller reMarkable før du lager en ny eksport. Dokumentet kan allerede være sendt."]
        : []),
      ...(job.error ? ["", job.error] : []),
    ].join("\n");
    return (
      <Detail
        isLoading={active}
        navigationTitle="Dagsplan til reMarkable"
        markdown={summary}
        actions={
          active ? undefined : (
            <ActionPanel>
              {job.state === "ready" && previewOpened ? (
                <Action title="Send Til reMarkable" icon={Icon.Upload} onAction={send} />
              ) : null}
              <Action title="Åpne Forhåndsvisning" icon={Icon.Document} onAction={() => openPreview(job)} />
              <Action
                title="Tilbake Til Oppgavevalg"
                icon={Icon.List}
                onAction={() => {
                  setJob(undefined);
                  setStage(undefined);
                  setPreviewOpened(false);
                }}
              />
              <Action.ShowInFinder title="Vis Eksportfiler" path={service.pdfPath(job)} />
              {job.documentId ? <Action.CopyToClipboard title="Kopier Dokument-ID" content={job.documentId} /> : null}
              <Action.CopyToClipboard title="Kopier Kommando for Opplastingsinnlogging" content="rm2 cloud login" />
            </ActionPanel>
          )
        }
      />
    );
  }
  const commonActions = () => (
    <>
      {folder && selected.size > 0 && !loading && !error ? (
        <Action
          title="Lag Forhåndsvisning"
          icon={Icon.Document}
          shortcut={{ modifiers: ["cmd"], key: "return" }}
          onAction={preview}
        />
      ) : null}
      <Action.Push
        title={folder ? "Endre Målmappe" : "Velg Målmappe"}
        icon={Icon.Folder}
        target={<FolderPicker service={service} onChoose={chooseFolder} />}
      />
      <Action title="Velg Alle Oppgaver" onAction={() => changeSelection(new Set(tasks.map((t) => t.id)))} />
      <Action title="Fjern Alle Valg" onAction={() => changeSelection(new Set())} />
      <Action title="Hent Ferske Oppgaver" icon={Icon.ArrowClockwise} onAction={reload} />
      {latest ? (
        <Action
          title="Åpne Siste Eksport"
          onAction={async () => {
            setJob(latest);
            setStage(latest.state);
            setPreviewOpened(false);
            await openPreview(latest);
          }}
        />
      ) : null}
      <Action title="Åpne Innstillinger" onAction={openCommandPreferences} />
    </>
  );
  if (busy.current)
    return (
      <Detail
        isLoading
        markdown={`# ${stage ? STATE_LABELS[stage] : "Henter ferske oppgaver …"}\n\nVent til forhåndsvisningen er klar.`}
      />
    );
  const visible = tasks.filter((t) =>
    `${t.title} ${t.projectName} ${t.parentTitle ?? ""}`
      .toLocaleLowerCase("nb")
      .includes(search.toLocaleLowerCase("nb")),
  );
  const groups = [...new Set(visible.map((t) => t.projectId))];
  return (
    <List
      isLoading={loading}
      filtering={false}
      searchText={search}
      onSearchTextChange={setSearch}
      navigationTitle={`Dagsplan · ${selected.size} valgt${folder ? ` · ${folder.name}` : " · velg målmappe"}`}
      searchBarPlaceholder="Søk i dagens og forfalte oppgaver"
    >
      <List.EmptyView
        title={error ? "Kunne ikke hente oppgaver" : "Ingen oppgaver"}
        description={error || "Ingen oppgaver passer til dagens dato og søk."}
        actions={<ActionPanel>{commonActions()}</ActionPanel>}
      />
      {groups.map((id) => (
        <List.Section key={id} title={visible.find((t) => t.projectId === id)?.projectName}>
          {visible
            .filter((t) => t.projectId === id)
            .map((t) => (
              <List.Item
                key={t.id}
                title={t.title}
                subtitle={t.parentTitle}
                icon={selected.has(t.id) ? { source: Icon.CheckCircle, tintColor: Color.Green } : Icon.Circle}
                accessories={[
                  ...(t.overdue ? [{ tag: { value: "Forfalt", color: Color.Red } }] : []),
                  { text: `P${t.priority}` },
                  ...(t.dueTime ? [{ text: t.dueTime }] : []),
                ]}
                actions={
                  <ActionPanel>
                    <Action
                      title={selected.has(t.id) ? "Ta Ut Av Dagsplanen" : "Ta Med I Dagsplanen"}
                      onAction={() => toggle(t.id)}
                    />
                    {commonActions()}
                  </ActionPanel>
                }
              />
            ))}
        </List.Section>
      ))}
    </List>
  );
}
const AuthenticatedCommand = withTodoistApi(DailyPlanCommand);
export default function Command() {
  return process.platform === "darwin" ? (
    <AuthenticatedCommand />
  ) : (
    <Detail markdown="# Krever macOS\n\nDagsplaner bruker macOS-skrifter og den lokale rm2-arbeidsflyten på Mac. De øvrige Todoist-kommandoene kan fortsatt brukes på Windows." />
  );
}
