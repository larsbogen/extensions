/* Norwegian action titles preserve the product language. */
/* eslint-disable @raycast/prefer-title-case */
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  closeMainWindow,
  launchCommand,
  LaunchType,
  showToast,
  useNavigation,
} from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../api";
import { startFocusedTask } from "../focus/service";
import { refreshMenuBarCommand } from "../helpers/menu-bar";
import { osloDay } from "../remarkable/plan";
import {
  activeEntries,
  addTaskToPlan,
  carryCandidates,
  eligibleTasks,
  isSuggested,
  moveEntry,
  reconcilePlan,
  removeEntry,
  toggleTopThree,
  type WorkdayEntry,
  type WorkdayPlan,
} from "../workday/model";
import { getWorkdayStore } from "../workday/runtime";
import { editWorkday, freshWorkdayData, loadWorkday } from "../workday/service";

type LoadedWorkday = Awaited<ReturnType<typeof loadWorkday>>;

function TaskPicker({
  initial,
  carryOnly,
  onChanged,
}: {
  initial: LoadedWorkday;
  carryOnly: boolean;
  onChanged: (plan: WorkdayPlan) => void;
}) {
  const [plan, setPlan] = useState(initial.plan);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const { pop } = useNavigation();
  const candidates = carryOnly
    ? carryCandidates(initial.previous, initial.data.items, initial.data.projects, plan.accountId)
    : eligibleTasks(initial.data.items, initial.data.projects, plan.accountId);
  const sections = carryOnly
    ? [{ title: `Uferdig fra ${initial.previous?.day}`, tasks: candidates }]
    : [
        { title: "Dagens og forfalte oppgaver", tasks: candidates.filter((task) => isSuggested(task, plan.day)) },
        { title: "Andre aktive oppgaver", tasks: candidates.filter((task) => !isSuggested(task, plan.day)) },
      ];
  async function add(task: Task) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (osloDay(new Date()) !== plan.day) throw new Error("Det er en ny dag. Åpne arbeidsdagen på nytt.");
      const observedAt = new Date().toISOString();
      const fresh = await freshWorkdayData();
      if (fresh.user.id !== plan.accountId) throw new Error("Todoist-kontoen er endret. Åpne arbeidsdagen på nytt.");
      const current = fresh.items.find((item) => item.id === task.id);
      if (!current) throw new Error("Oppgaven er ikke lenger tilgjengelig.");
      const next = await getWorkdayStore().update(plan.accountId, plan.day, (value) =>
        addTaskToPlan(
          reconcilePlan(value, fresh.items, fresh.projects, fresh.user.id, [], observedAt),
          current,
          fresh.projects,
        ),
      );
      setPlan(next);
      onChanged(next);
      await showToast({ style: Toast.Style.Success, title: "Lagt til i arbeidsdagen" });
    } catch (error) {
      await showFailureToast(error, { title: "Kunne ikke legge til oppgaven" });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <List
      isLoading={busy}
      navigationTitle={carryOnly ? "Velg hva som videreføres" : "Velg oppgaver til arbeidsdagen"}
      searchBarPlaceholder="Søk blant dine aktive oppgaver"
    >
      <List.EmptyView
        title="Ingen tilgjengelige oppgaver"
        actions={
          <ActionPanel>
            <Action title="Ferdig" onAction={pop} />
          </ActionPanel>
        }
      />
      {sections.map((section) => (
        <List.Section key={section.title} title={section.title}>
          {section.tasks.map((task) => {
            const selected = activeEntries(plan).some((entry) => entry.taskId === task.id);
            return (
              <List.Item
                key={task.id}
                title={task.content}
                subtitle={initial.data.projects.find((p) => p.id === task.project_id)?.name}
                icon={selected ? Icon.CheckCircle : Icon.Circle}
                accessories={selected ? [{ text: "Valgt" }] : []}
                actions={
                  <ActionPanel>
                    {selected ? (
                      <Action title="Tilbake til arbeidsdagen" onAction={pop} />
                    ) : (
                      <Action title="Legg til i arbeidsdagen" icon={Icon.Plus} onAction={() => add(task)} />
                    )}
                    <Action title="Ferdig" onAction={pop} shortcut={{ modifiers: ["cmd"], key: "return" }} />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      ))}
    </List>
  );
}

export function WorkdaySections({ pickTasks = false }: { pickTasks?: boolean }) {
  const [state, setState] = useState<LoadedWorkday>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const serial = useRef(0);
  const pending = useRef(false);
  const didPick = useRef(false);
  const { push } = useNavigation();
  const reload = useCallback(async () => {
    if (pending.current) return;
    const request = ++serial.current;
    setBusy(true);
    setError(undefined);
    try {
      const value = await loadWorkday();
      if (request === serial.current) setState(value);
    } catch (error) {
      if (request === serial.current)
        setError(error instanceof Error ? error.message : "Kunne ikke hente arbeidsdagen.");
    } finally {
      if (request === serial.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => {
      serial.current++;
    };
  }, [reload]);
  const changed = useCallback((plan: WorkdayPlan) => {
    setState((previous) =>
      previous && previous.plan.accountId === plan.accountId && previous.day === plan.day
        ? { ...previous, plan }
        : previous,
    );
  }, []);
  useEffect(() => {
    if (pickTasks && state && !didPick.current) {
      didPick.current = true;
      push(<TaskPicker initial={state} carryOnly={false} onChanged={changed} />);
    }
  }, [state, pickTasks, push, changed]);

  async function mutate(change: (plan: WorkdayPlan) => WorkdayPlan) {
    if (!state || pending.current || busy) return;
    pending.current = true;
    setBusy(true);
    try {
      if (state.day !== osloDay(new Date())) throw new Error("Det er en ny dag. Oppdater arbeidsdagen først.");
      changed(await editWorkday(state.plan.accountId, state.day, change));
    } catch (error) {
      await showFailureToast(error, { title: "Kunne ikke endre arbeidsdagen" });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function start(entry?: WorkdayEntry) {
    if (!state || pending.current || busy) return;
    pending.current = true;
    setBusy(true);
    try {
      const fresh = await loadWorkday();
      if (fresh.plan.accountId !== state.plan.accountId || fresh.day !== state.day) {
        setState(fresh);
        throw new Error("Kontoen eller dagen er endret. Velg fokusoppgaven på nytt.");
      }
      setState(fresh);
      const chosen = entry
        ? activeEntries(fresh.plan).find((value) => value.id === entry.id)
        : activeEntries(fresh.plan)[0];
      const task = fresh.data.items.find((value) => value.id === chosen?.taskId);
      if (!chosen || !task) throw new Error("Ingen tilgjengelig fokusoppgave i utvalget.");
      await startFocusedTask(
        task,
        { data: fresh.data, setData: () => undefined },
        {
          accountId: fresh.plan.accountId,
          day: fresh.day,
          entryId: chosen.id,
          revision: fresh.plan.revision,
        },
      );
      await refreshMenuBarCommand();
      await closeMainWindow();
    } catch (error) {
      await showFailureToast(error, { title: "Kunne ikke starte fokus" });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function commonActions() {
    return (
      <ActionPanel.Section>
        {state && (
          <Action.Push
            title="Legg til oppgaver"
            icon={Icon.Plus}
            target={<TaskPicker initial={state} carryOnly={false} onChanged={changed} />}
          />
        )}
        {state &&
          carryCandidates(state.previous, state.data.items, state.data.projects, state.plan.accountId).length > 0 && (
            <Action.Push
              title="Velg hva som videreføres"
              icon={Icon.ArrowRight}
              target={<TaskPicker initial={state} carryOnly={true} onChanged={changed} />}
            />
          )}
        <Action
          title="Oppdater arbeidsdagen"
          icon={Icon.ArrowClockwise}
          onAction={reload}
          shortcut={{ modifiers: ["cmd"], key: "r" }}
        />
        <Action
          title="Åpne arbeidsoversikt"
          icon={Icon.BarChart}
          onAction={() => launchCommand({ name: "work-overview", type: LaunchType.UserInitiated })}
        />
        <Action
          title="Lag dagsplan til reMarkable"
          icon={Icon.Document}
          onAction={() => launchCommand({ name: "send-daily-plan", type: LaunchType.UserInitiated })}
        />
      </ActionPanel.Section>
    );
  }
  const plan = state?.plan;
  return (
    <>
      {error && (
        <List.Section title="Oppdatering mislyktes">
          <List.Item
            title={error}
            icon={{ source: Icon.Warning, tintColor: Color.Orange }}
            actions={<ActionPanel>{commonActions()}</ActionPanel>}
          />
        </List.Section>
      )}
      <List.Section
        title={state ? `Min arbeidsdag · ${state.day}` : "Min arbeidsdag"}
        subtitle={busy ? "Oppdaterer …" : "Topp tre er markeringer, ikke rekkefølge"}
      >
        <List.Item
          title={
            plan && activeEntries(plan).length
              ? "Start dagens fokus"
              : busy
                ? "Henter arbeidsdagen …"
                : "Velg oppgaver til arbeidsdagen"
          }
          icon={Icon.Center}
          subtitle={plan ? `${activeEntries(plan).length} oppgaver valgt` : undefined}
          actions={
            <ActionPanel>
              {plan && activeEntries(plan).length > 0 && (
                <Action title="Start dagens fokus" icon={Icon.Play} onAction={() => start()} />
              )}
              {commonActions()}
            </ActionPanel>
          }
        />
        {plan &&
          activeEntries(plan).map((entry, index) => (
            <List.Item
              key={entry.id}
              id={entry.id}
              title={entry.title}
              subtitle={entry.projectName}
              keywords={[entry.projectName]}
              icon={{
                source: plan.topThree.includes(entry.id) ? Icon.Star : Icon.Circle,
                tintColor: plan.topThree.includes(entry.id) ? Color.Yellow : undefined,
              }}
              accessories={[
                { text: `${index + 1}` },
                ...(plan.topThree.includes(entry.id) ? [{ tag: "Topp tre" }] : []),
              ]}
              actions={
                <ActionPanel>
                  <Action title="Start fokus herfra" icon={Icon.Play} onAction={() => start(entry)} />
                  <Action
                    title={plan.topThree.includes(entry.id) ? "Fjern topp tre-markering" : "Marker som topp tre"}
                    icon={Icon.Star}
                    onAction={() => mutate((value) => toggleTopThree(value, entry.id))}
                  />
                  <Action
                    title="Flytt opp"
                    icon={Icon.ArrowUp}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "arrowUp" }}
                    onAction={() => mutate((value) => moveEntry(value, entry.id, -1))}
                  />
                  <Action
                    title="Flytt ned"
                    icon={Icon.ArrowDown}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "arrowDown" }}
                    onAction={() => mutate((value) => moveEntry(value, entry.id, 1))}
                  />
                  <Action
                    title="Fjern fra dagen"
                    icon={Icon.MinusCircle}
                    onAction={() => mutate((value) => removeEntry(value, entry.id))}
                  />
                  <Action.OpenInBrowser
                    title="Åpne oppgave i Todoist"
                    url={`https://app.todoist.com/app/task/${encodeURIComponent(entry.taskId)}`}
                  />
                  {commonActions()}
                </ActionPanel>
              }
            />
          ))}
      </List.Section>
      {(["completed", "unavailable"] as const).map((status) => (
        <List.Section key={status} title={status === "completed" ? "Fullført" : "Ikke lenger tilgjengelig i utvalget"}>
          {plan?.entries
            .filter((entry) => entry.status === status)
            .map((entry) => (
              <List.Item
                key={entry.id}
                title={entry.title}
                subtitle={entry.projectName}
                icon={status === "completed" ? Icon.CheckCircle : Icon.Warning}
                actions={
                  <ActionPanel>
                    <Action title="Fjern fra dagen" onAction={() => mutate((value) => removeEntry(value, entry.id))} />
                    {commonActions()}
                  </ActionPanel>
                }
              />
            ))}
        </List.Section>
      ))}
    </>
  );
}

export function WorkdayView({ pickTasks = false }: { pickTasks?: boolean }) {
  return (
    <List navigationTitle="Min arbeidsdag" searchBarPlaceholder="Finn en oppgave i arbeidsdagen">
      <WorkdaySections pickTasks={pickTasks} />
    </List>
  );
}
