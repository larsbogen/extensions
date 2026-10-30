/* Norwegian labels preserve the language used in the focus panel. */
/* eslint-disable @raycast/prefer-title-case */
import { Action, ActionPanel, Color, Icon, List, environment } from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { join } from "node:path";
import removeMarkdown from "remove-markdown";

import { getTodoistApi, withTodoistApi } from "./helpers/withTodoistApi";
import { formatReportDay, osloDate, reportRange, shiftRange, type ReportMode } from "./reports/dates";
import { durationLabel, TIME_STATUS_LABELS, timeTotals, type TimeSlice, type TimeStatus } from "./reports/model";
import { WorkReportService, type WorkReport } from "./reports/service";

const escapeMarkdown = (value: string) => value.replace(/[\\`*_{}[\]()#+.!|<>-]/g, "\\$&");
const timestamp = (value: string) =>
  new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
const categories = Object.keys(TIME_STATUS_LABELS) as TimeStatus[];

function summaryMarkdown(report: WorkReport, slices: TimeSlice[], completions: number, projectName?: string): string {
  const totals = timeTotals(slices);
  const incomplete = report.completions.coverage !== "complete";
  const notes = [...report.issues, ...report.focus.issues, ...report.completions.issues];
  const legacy = timeTotals(report.focus.legacySlices);
  return [
    `# ${projectName ? escapeMarkdown(projectName) : "Arbeidsoversikt"}`,
    `**${formatReportDay(report.range.day)}${report.range.mode === "week" ? ` – ${formatReportDay(report.range.days[report.range.days.length - 1])}` : ""}**`,
    `Konto: ${escapeMarkdown(report.account.name)}${report.offline ? " (sist bekreftet)" : ""}`,
    `## ${report.localAvailable ? durationLabel(totals.seconds) : "Ukjent"} fokustid`,
    "Arbeidstid målt av fokusvinduet. Pauser inngår ikke.",
    ...categories.map(
      (status) =>
        `- ${TIME_STATUS_LABELS[status]}: ${report.localAvailable ? durationLabel(totals.status[status]) : "ukjent"}`,
    ),
    `## ${incomplete ? (completions ? `Minst ${completions}` : "Ukjent antall") : completions} fullføringer`,
    "Fullføringer utført av deg i Todoist, også fra andre klienter. Gjentatte fullføringer telles hver for seg; senere gjenåpning trekker dem ikke fra.",
    ...(legacy.seconds > 0
      ? [
          "## Eldre lokal historikk",
          `${durationLabel(legacy.seconds)} uten sikker kontotilknytning, utenfor hovedtallene${projectName ? " (alle prosjekter)" : ""}.`,
        ]
      : []),
    ...(notes.length
      ? ["## Datadekning", ...[...new Set(notes)].map((note) => `- ${escapeMarkdown(note)}`)]
      : ["Begge datakildene er lest uten feil for denne visningen."]),
    `Oppdatert ${timestamp(report.fetchedAt)}.`,
    ...(report.focus.updatedAt ? [`Siste lokale kontrollpunkt: ${timestamp(report.focus.updatedAt)}.`] : []),
    ...(report.completions.cachedAt ? [`Lagret Todoist-historikk fra ${timestamp(report.completions.cachedAt)}.`] : []),
    "Toggl-status viser sist bekreftede synkronisering; rapporten gjør ingen nye Toggl-kall.",
  ].join("\n\n");
}

export function WorkOverview() {
  const [mode, setMode] = useState<ReportMode>("day");
  const [day, setDay] = useState(() => osloDate(new Date()));
  const [projectId, setProjectId] = useState("all");
  const [report, setReport] = useState<WorkReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const range = useMemo(() => reportRange(day, mode), [day, mode]);
  const service = useMemo(
    () =>
      new WorkReportService(
        join(environment.supportPath, "work-reports"),
        join(environment.supportPath, "focus-panel", "state.json"),
        getTodoistApi(),
      ),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setReport(undefined);
    service
      .load(range)
      .then((value) => {
        if (!cancelled) setReport(value);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Kunne ikke hente arbeidsoversikten.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, refresh, service]);

  const update = useCallback(() => setRefresh((value) => value + 1), []);
  const move = (direction: number) => setDay(shiftRange(range, direction).day);
  const projects = useMemo(() => {
    const names = new Map(report?.projects.map((project) => [project.id, project.name]) ?? []);
    for (const slice of report?.focus.slices ?? []) names.set(slice.projectId, slice.projectName);
    for (const event of report?.completions.events ?? [])
      if (!names.has(event.projectId)) names.set(event.projectId, "Ukjent prosjekt");
    if (projectId !== "all" && !names.has(projectId)) names.set(projectId, "Valgt prosjekt");
    return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "nb"));
  }, [report, projectId]);
  const slices = report?.focus.slices.filter((slice) => projectId === "all" || slice.projectId === projectId) ?? [];
  const events =
    report?.completions.events.filter((event) => projectId === "all" || event.projectId === projectId) ?? [];
  const selectedName = projects.find((project) => project.id === projectId)?.name;
  const actions = (
    <ActionPanel>
      <Action
        title="Oppdater"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={update}
      />
      <Action
        title={mode === "day" ? "Vis uke" : "Vis dag"}
        icon={Icon.Calendar}
        onAction={() => setMode(mode === "day" ? "week" : "day")}
      />
      <Action
        title="Forrige periode"
        icon={Icon.ArrowLeft}
        shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }}
        onAction={() => move(-1)}
      />
      <Action
        title="Neste periode"
        icon={Icon.ArrowRight}
        shortcut={{ modifiers: ["cmd"], key: "arrowRight" }}
        onAction={() => move(1)}
      />
      <Action title="Tilbake til i dag" icon={Icon.Calendar} onAction={() => setDay(osloDate(new Date()))} />
    </ActionPanel>
  );
  return (
    <List
      isLoading={loading}
      isShowingDetail
      navigationTitle={`Arbeidsoversikt · ${mode === "day" ? "Dag" : "Uke"} · ${formatReportDay(range.day)}`}
      searchBarPlaceholder="Søk i oppgaver og prosjekter"
      searchBarAccessory={
        <List.Dropdown tooltip="Prosjekt" value={projectId} onChange={setProjectId}>
          <List.Dropdown.Item title="Alle prosjekter" value="all" />
          {projects.map((project) => (
            <List.Dropdown.Item key={project.id} title={project.name} value={project.id} />
          ))}
        </List.Dropdown>
      }
    >
      {!report ? (
        <List.EmptyView
          title={error ? "Kunne ikke hente arbeidsoversikten" : "Henter arbeidsoversikt …"}
          description={error}
          actions={actions}
        />
      ) : (
        <>
          <List.Item
            title="Sammendrag"
            icon={Icon.BarChart}
            subtitle={report.offline ? "Frakoblet" : undefined}
            detail={<List.Item.Detail markdown={summaryMarkdown(report, slices, events.length, selectedName)} />}
            actions={actions}
          />
          <List.Section title="Arbeidstid per dag">
            {range.days.map((date) => {
              const daily = slices.filter((slice) => slice.day === date);
              const total = timeTotals(daily);
              return (
                <List.Item
                  key={date}
                  title={formatReportDay(date)}
                  icon={Icon.Clock}
                  accessories={[{ text: report.localAvailable ? durationLabel(total.seconds) : "Ukjent" }]}
                  detail={
                    <List.Item.Detail
                      markdown={`# ${formatReportDay(date)}\n\n${categories.map((status) => `- ${TIME_STATUS_LABELS[status]}: ${report.localAvailable ? durationLabel(total.status[status]) : "ukjent"}`).join("\n")}\n\n${daily.length ? daily.map((slice) => `- ${escapeMarkdown(slice.title)} · ${durationLabel(slice.seconds)} · ${escapeMarkdown(slice.projectName)}`).join("\n") : report.localAvailable ? "Ingen registrerte arbeidsperioder for dette utvalget." : "Lokal arbeidstid kunne ikke leses."}`}
                    />
                  }
                  actions={actions}
                />
              );
            })}
          </List.Section>
          <List.Section title="Arbeidstid per prosjekt">
            {projects
              .filter((project) => slices.some((slice) => slice.projectId === project.id))
              .map((project) => {
                const projectSlices = slices.filter((slice) => slice.projectId === project.id);
                return (
                  <List.Item
                    key={`project-${project.id}`}
                    title={project.name}
                    icon={Icon.Folder}
                    accessories={[{ text: durationLabel(timeTotals(projectSlices).seconds) }]}
                    detail={
                      <List.Item.Detail
                        markdown={summaryMarkdown(
                          report,
                          projectSlices,
                          events.filter((event) => event.projectId === project.id).length,
                          project.name,
                        )}
                      />
                    }
                    actions={actions}
                  />
                );
              })}
          </List.Section>
          {report.focus.legacySlices.length > 0 ? (
            <List.Section title="Eldre lokal historikk" subtitle="Uten sikker kontotilknytning">
              <List.Item
                title="Eldre arbeidsperioder"
                icon={Icon.Clock}
                accessories={[{ text: durationLabel(timeTotals(report.focus.legacySlices).seconds) }]}
                detail={
                  <List.Item.Detail
                    markdown={`# Eldre lokal historikk\n\nDisse periodene har ingen sikker kontotilknytning og inngår ikke i hovedtallene. Alle prosjekter vises.\n\n${report.focus.legacySlices.map((slice) => `- ${formatReportDay(slice.day)} · ${escapeMarkdown(slice.title)} · ${durationLabel(slice.seconds)} · ${escapeMarkdown(slice.projectName)}`).join("\n")}`}
                  />
                }
                actions={actions}
              />
            </List.Section>
          ) : null}
          <List.Section
            title="Fullføringer"
            subtitle={report.completions.coverage === "complete" ? `${events.length}` : "Ufullstendig dekning"}
          >
            {events.map((event) => (
              <List.Item
                key={`completion-${event.id}`}
                title={removeMarkdown(event.title)}
                icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
                subtitle={projects.find((project) => project.id === event.projectId)?.name}
                detail={
                  <List.Item.Detail
                    markdown={`# ${escapeMarkdown(event.title)}\n\nFullført ${timestamp(event.at)}.\n\n${escapeMarkdown(projects.find((project) => project.id === event.projectId)?.name ?? "Ukjent prosjekt")}`}
                  />
                }
                actions={actions}
              />
            ))}
          </List.Section>
        </>
      )}
    </List>
  );
}

export default withTodoistApi(WorkOverview);
