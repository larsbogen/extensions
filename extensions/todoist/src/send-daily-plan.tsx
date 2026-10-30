/* Norwegian action titles preserve product spelling. */
/* eslint-disable @raycast/prefer-title-case */
import {
  Action,
  ActionPanel,
  Color,
  Detail,
  environment,
  Form,
  getPreferenceValues,
  Icon,
  List,
  LocalStorage,
  launchCommand,
  LaunchType,
  open,
  openCommandPreferences,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initialSync } from "./api";
import { withTodoistApi } from "./helpers/withTodoistApi";
import { createPlanPdf } from "./remarkable/pdf";
import {
  createWorkdaySnapshot,
  isSnapshotStale,
  osloDay,
  planTasks,
  previewPage,
  type PlanTask,
} from "./remarkable/plan";
import { reconcilePlan, type WorkdayPlan } from "./workday/model";
import { getWorkdayStore } from "./workday/runtime";
import {
  DailyPlanService,
  shouldResumePreview,
  type ExportJob,
  type Folder,
  type JobState,
  type ToolPreferences,
} from "./remarkable/service";

const FOLDER_KEY = "remarkable-daily-plan-folder-v1";
const STATE_LABELS: Record<JobState, string> = {
  exporting: "Lager PDF …",
  validating: "Validerer alle PDF-sider …",
  ready: "Klar til sending – ikke sendt ennå",
  sending: "Sender til reMarkable …",
  sent: "Sendt til reMarkable Cloud",
  uncertain: "Sending ikke bekreftet",
  error: "Eksport mislyktes",
};
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Operasjonen mislyktes.");

function CreateFolderForm({
  service,
  onCreated,
  onCancel,
}: {
  service: DailyPlanService;
  onCreated: (folder: Folder) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("Dagsplaner");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  async function submit() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const folder = await service.createFolder(name);
      await onCreated(folder);
      await showToast({ style: Toast.Style.Success, title: "Målmappen er klar", message: folder.name });
    } catch (e) {
      setError(errorMessage(e));
      await showToast({ style: Toast.Style.Failure, title: "Kunne ikke opprette mappe", message: errorMessage(e) });
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }
  if (loading)
    return (
      <Detail
        isLoading
        navigationTitle="Opprett mappe"
        markdown={"# Oppretter mappe …\n\nVent mens reMarkable bekrefter målmappe."}
      />
    );
  return (
    <Form
      navigationTitle="Opprett mappe på reMarkable"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Opprett Og Velg Mappe" icon={Icon.NewFolder} onSubmit={submit} />
          <Action title="Tilbake Til Mapper" onAction={onCancel} />
          <Action.CopyToClipboard title="Kopier Kommando for Mappeinnlogging" content="rm2 cloud web-login" />
        </ActionPanel>
      }
    >
      <Form.Description text="Mappen opprettes i Mine filer på reMarkable og velges som målmappe. Hvis en mappe med samme navn allerede finnes der, brukes den. Krever innlogging for mapper og opplasting." />
      <Form.TextField id="folderName" title="Mappenavn" value={name} onChange={setName} error={error} />
    </Form>
  );
}

function FolderPicker({
  service,
  onChoose,
}: {
  service: DailyPlanService;
  onChoose: (folder: Folder) => Promise<void>;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [creating, setCreating] = useState(false);
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
  if (creating)
    return (
      <CreateFolderForm
        service={service}
        onCancel={() => setCreating(false)}
        onCreated={async (folder) => {
          await onChoose(folder);
          pop();
        }}
      />
    );
  const createAction = <Action title="Opprett Ny Mappe" icon={Icon.NewFolder} onAction={() => setCreating(true)} />;
  return (
    <List
      isLoading={loading}
      navigationTitle="Velg mappe på reMarkable"
      searchBarPlaceholder="Finn Dagsplaner eller en annen mappe"
    >
      <List.EmptyView
        title={error ? "Kunne ikke hente mapper" : "Ingen mapper funnet"}
        description={error || "Velg Opprett ny mappe for å lage Dagsplaner eller en annen målmappe."}
        actions={
          <ActionPanel>
            {createAction}
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
              {createAction}
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
        createPlanPdf(snapshot, output, path.join(environment.assetsPath, "daily-plan")),
      ),
    [prefs.rm2Path, prefs.pdfinfoPath, prefs.pdftoppmPath],
  );
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [plan, setPlan] = useState<WorkdayPlan>();
  const [folder, setFolder] = useState<Folder>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<JobState>();
  const [job, setJob] = useState<ExportJob>();
  const [latest, setLatest] = useState<ExportJob>();
  const [pages, setPages] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const busy = useRef(false);
  const previewRequest = useRef(0);

  const fetchFresh = useCallback(async () => {
    const observedAt = new Date().toISOString();
    const data = await initialSync(["user", "projects", "items"]);
    if (!data.user?.id || !Array.isArray(data.items) || !Array.isArray(data.projects))
      throw new Error("Todoist returnerte ufullstendige data.");
    const store = getWorkdayStore();
    const day = osloDay(new Date());
    const existing = await store.read(data.user.id, day);
    const current = existing
      ? await store.update(data.user.id, day, (value) =>
          reconcilePlan(value, data.items!, data.projects!, data.user!.id, [], observedAt),
        )
      : undefined;
    const byId = new Map(planTasks(data.items, data.projects, data.user.id).map((task) => [task.id, task]));
    const chosen =
      current?.entries
        .filter((entry) => entry.status === "active")
        .flatMap((entry) => (byId.has(entry.taskId) ? [byId.get(entry.taskId)!] : [])) ?? [];
    setPlan(current);
    setTasks(chosen);
    return { data, plan: current };
  }, []);
  const reload = useCallback(async () => {
    if (busy.current) return;
    setLoading(true);
    setError("");
    try {
      const fresh = await fetchFresh();
      const saved = await service.latest(fresh.data.user!.id).catch(() => undefined);
      const compatible =
        saved && (saved.snapshot.version === 1 || saved.snapshot.workday.accountId === fresh.data.user!.id)
          ? saved
          : undefined;
      setLatest(compatible);
      return compatible;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [fetchFresh, service]);
  useEffect(() => {
    let cancelled = false;
    void reload().then((saved) => {
      if (!cancelled && shouldResumePreview(saved) && saved.snapshot.version === 2) setJob(saved);
    });
    void LocalStorage.getItem<string>(FOLDER_KEY).then((raw) => {
      if (!raw || cancelled) return;
      try {
        const stored = JSON.parse(raw);
        if (typeof stored.id === "string" && typeof stored.name === "string") setFolder(stored);
      } catch {
        /* choose again */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);
  const loadPreview = useCallback(
    async (value: ExportJob) => {
      const request = ++previewRequest.current;
      setPreviewLoading(true);
      setPreviewError("");
      try {
        const rendered = await service.previewPages(value.id);
        if (request === previewRequest.current) setPages(rendered);
      } catch (e) {
        if (request === previewRequest.current) {
          setPages([]);
          setPreviewError(errorMessage(e));
        }
      } finally {
        if (request === previewRequest.current) setPreviewLoading(false);
      }
    },
    [service],
  );
  useEffect(() => {
    setPage(0);
    setPages([]);
    if (job) void loadPreview(job);
    return () => {
      previewRequest.current++;
    };
  }, [job?.id, loadPreview]);
  const chooseFolder = async (value: Folder) => {
    await LocalStorage.setItem(FOLDER_KEY, JSON.stringify(value));
    setFolder(value);
    setJob(undefined);
  };
  const editWorkday = () =>
    launchCommand({
      name: "my-workday",
      type: LaunchType.UserInitiated,
      context: { pickTasks: !plan || tasks.length === 0 },
    });
  async function preview() {
    if (busy.current || !folder || loading) return;
    busy.current = true;
    setLoading(true);
    setStage("exporting");
    try {
      const fresh = await fetchFresh();
      if (!fresh.plan) throw new Error("Velg oppgaver i Min arbeidsdag før du lager dagsplanen.");
      const snapshot = createWorkdaySnapshot(fresh.plan, fresh.data.items!, fresh.data.projects!);
      const exported = await service.export(snapshot, folder, setStage);
      setJob(exported);
      setLatest(exported);
    } catch (e) {
      setStage("error");
      await showToast({ style: Toast.Style.Failure, title: "Kunne ikke lage dagsplan", message: errorMessage(e) });
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }
  async function send() {
    if (busy.current || !job || job.state !== "ready") return;
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
      const saved = await service.load(job.id).catch(() => undefined);
      if (saved) {
        setJob(saved);
        setStage(saved.state);
      } else setStage("error");
      await showToast({ style: Toast.Style.Failure, title: "Sending stoppet", message: errorMessage(e) });
    } finally {
      busy.current = false;
    }
  }
  if (job) {
    const sending = stage === "sending" && busy.current;
    const uncertain = job.state === "uncertain" || (job.state === "sending" && !sending);
    const stale = isSnapshotStale(job.snapshot, plan);
    const title = sending ? STATE_LABELS.sending : uncertain ? "Sending ikke bekreftet" : STATE_LABELS[job.state];
    const currentPage = Math.min(page, Math.max(0, pages.length - 1));
    const markdown = [
      `**${title} · Side ${currentPage + 1} av ${job.pages}**`,
      `Mappe: ${job.folder.name} · ${job.snapshot.tasks.length} oppgaver`,
      ...(stale ? ["**Arbeidsdagen er endret. Lag en ny forhåndsvisning for å ta med endringene.**"] : []),
      ...(previewError ? [previewError] : []),
      ...(pages[currentPage] ? [`![Side ${currentPage + 1}](<${pathToFileURL(pages[currentPage]).href}>)`] : []),
      "PDF-en er et frosset øyeblikksbilde. Avkrysninger og notater synkroniseres ikke til Todoist.",
      ...(uncertain ? ["Kontroller reMarkable før du lager en ny eksport. Dokumentet kan allerede være sendt."] : []),
      ...(job.error ? [job.error] : []),
    ].join("\n\n");
    return (
      <Detail
        isLoading={sending || previewLoading}
        navigationTitle={`Dagsplan · Side ${currentPage + 1} av ${job.pages}`}
        markdown={markdown}
        actions={
          sending ? undefined : (
            <ActionPanel>
              <Action
                title="Neste Side"
                icon={Icon.ArrowRight}
                shortcut={{ modifiers: ["cmd"], key: "arrowRight" }}
                onAction={() => setPage(previewPage(currentPage, 1, pages.length))}
              />
              {currentPage > 0 ? (
                <Action
                  title="Forrige Side"
                  icon={Icon.ArrowLeft}
                  shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }}
                  onAction={() => setPage(previewPage(currentPage, -1, pages.length))}
                />
              ) : null}
              <ActionPanel.Section title="Dokument">
                {job.state === "ready" ? (
                  <Action
                    title="Send Til reMarkable"
                    icon={Icon.Upload}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
                    onAction={send}
                  />
                ) : null}
                {previewError ? (
                  <Action
                    title="Last Forhåndsvisningen På Nytt"
                    icon={Icon.ArrowClockwise}
                    onAction={() => loadPreview(job)}
                  />
                ) : null}
                <Action title="Åpne PDF Eksternt" icon={Icon.Document} onAction={() => open(service.pdfPath(job))} />
                <Action
                  title="Kontroller Arbeidsdagen"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={reload}
                />
                <Action
                  title="Tilbake Til Arbeidsdagen"
                  icon={Icon.List}
                  onAction={() => {
                    setJob(undefined);
                    setStage(undefined);
                    void reload();
                  }}
                />
                <Action.ShowInFinder title="Vis Eksportfiler" path={service.pdfPath(job)} />
                {job.documentId ? <Action.CopyToClipboard title="Kopier Dokument-ID" content={job.documentId} /> : null}
              </ActionPanel.Section>
            </ActionPanel>
          )
        }
      />
    );
  }
  const commonActions = () => (
    <>
      {folder && tasks.length > 0 && !loading && !error ? (
        <Action
          title="Lag Forhåndsvisning"
          icon={Icon.Document}
          shortcut={{ modifiers: ["cmd"], key: "return" }}
          onAction={preview}
        />
      ) : null}
      <Action
        title={plan ? "Rediger Min Arbeidsdag" : "Velg Oppgaver Til Arbeidsdagen"}
        icon={Icon.List}
        onAction={editWorkday}
      />
      <Action.Push
        title={folder ? "Endre Målmappe" : "Velg Målmappe"}
        icon={Icon.Folder}
        target={<FolderPicker service={service} onChoose={chooseFolder} />}
      />
      <Action
        title="Hent Arbeidsdagen På Nytt"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={reload}
      />
      {latest ? (
        <Action
          title="Åpne Siste Eksport"
          onAction={() => {
            setJob(latest);
            setStage(latest.state);
          }}
        />
      ) : null}
      <Action title="Åpne Innstillinger" onAction={openCommandPreferences} />
    </>
  );
  if (busy.current) return <Detail isLoading markdown={`# ${stage ? STATE_LABELS[stage] : "Henter arbeidsdagen …"}`} />;
  return (
    <List
      isLoading={loading}
      navigationTitle={`Dagsplan · ${tasks.length} oppgaver${folder ? ` · ${folder.name}` : " · velg målmappe"}`}
      searchBarPlaceholder="Søk i arbeidsdagens valgte oppgaver"
    >
      <List.EmptyView
        title={error ? "Kunne ikke hente arbeidsdagen" : "Velg oppgaver i Min arbeidsdag"}
        description={error || "Dagsplanen bruker samme utvalg, topp tre og rekkefølge som arbeidsdagen og fokuskøen."}
        actions={<ActionPanel>{commonActions()}</ActionPanel>}
      />
      {tasks.map((task, index) => {
        const entry = plan?.entries.find((entry) => entry.status === "active" && entry.taskId === task.id);
        const top = entry ? plan?.topThree.indexOf(entry.id) : -1;
        return (
          <List.Item
            key={entry?.id ?? task.id}
            title={`${index + 1}. ${task.title}`}
            subtitle={task.projectName}
            icon={top !== undefined && top >= 0 ? Icon.Star : Icon.Circle}
            accessories={[
              ...(task.overdue ? [{ tag: { value: "Forfalt", color: Color.Red } }] : []),
              ...(task.dueTime ? [{ text: task.dueTime }] : []),
            ]}
            actions={<ActionPanel>{commonActions()}</ActionPanel>}
          />
        );
      })}
    </List>
  );
}
const AuthenticatedCommand = withTodoistApi(DailyPlanCommand);
export default function Command() {
  return process.platform === "darwin" ? (
    <AuthenticatedCommand />
  ) : (
    <Detail
      markdown={
        "# Krever macOS\n\nDagsplaner bruker macOS-skrifter og den lokale rm2-arbeidsflyten på Mac. De øvrige Todoist-kommandoene kan fortsatt brukes på Windows."
      }
    />
  );
}
