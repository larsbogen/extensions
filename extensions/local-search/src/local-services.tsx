/* Norwegian product text uses sentence case. */
/* eslint-disable @raycast/prefer-title-case */
import {
  Action,
  ActionPanel,
  Detail,
  getPreferenceValues,
  Icon,
  List,
  Keyboard,
  open,
  openExtensionPreferences,
  showInFinder,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  literalLog,
  names,
  readLog,
  ServiceControl,
  type ServiceKind,
  type Status,
} from "./service-control";
const labels = {
  ready: "Kjører",
  stopped: "Stoppet",
  transitioning: "Starter/stopper",
  unknown: "Kan ikke bekrefte status",
};
export function LogView({ kind, file }: { kind: ServiceKind; file: string }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [exists, setExists] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const value = await readLog(file);
      setText(value ? literalLog(value) : "Loggen er tom.");
      setExists(true);
    } catch (error) {
      setExists(false);
      setText(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "Ingen loggfil er opprettet ennå."
          : "Loggen kunne ikke leses. Kontroller tilgang og loggsti.",
      );
    } finally {
      setLoading(false);
    }
  }, [file]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <Detail
      navigationTitle={`${names[kind]} – logg`}
      markdown={text}
      isLoading={loading}
      actions={
        <ActionPanel>
          <Action
            title="Oppdater logg"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={reload}
          />
          {exists && (
            <Action
              title="Vis loggfil i Finder"
              icon={Icon.Finder}
              onAction={async () => {
                try {
                  await showInFinder(file);
                } catch {
                  await showToast({
                    style: Toast.Style.Failure,
                    title: "Kunne ikke vise loggfilen",
                  });
                }
              }}
            />
          )}
        </ActionPanel>
      }
    />
  );
}
function ServiceRow({
  kind,
  control,
  revision,
  refresh,
}: {
  kind: ServiceKind;
  control: ServiceControl;
  revision: number;
  refresh: () => void;
}) {
  const [status, setStatus] = useState<Status>();
  const [checked, setChecked] = useState<Date>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const operation = useRef(false),
    sequence = useRef(0);
  const { push } = useNavigation();
  useEffect(() => {
    if (operation.current) return;
    const id = ++sequence.current;
    setLoading(true);
    void control.status(kind).then((s) => {
      if (sequence.current === id) {
        setStatus(s);
        setChecked(new Date());
        setLoading(false);
      }
    });
    return () => {
      sequence.current++;
    };
  }, [control, kind, revision]);
  async function perform(action: "start" | "open" | "stop", alsoOpen = false) {
    if (operation.current) return;
    operation.current = true;
    sequence.current++;
    setBusy(true);
    try {
      const result = await control.perform(kind, action, open, alsoOpen);
      setStatus(result.status);
      setChecked(new Date());
      if (result.error)
        await showToast({
          style: Toast.Style.Failure,
          title: "Handlingen kunne ikke bekreftes",
          message: result.error,
        });
    } catch {
      await showToast({
        style: Toast.Style.Failure,
        title: "En handling pågår allerede",
      });
    } finally {
      operation.current = false;
      setBusy(false);
      setLoading(false);
    }
  }
  const state = busy
    ? "Starter/stopper"
    : loading
      ? "Kontrollerer"
      : status
        ? labels[status.state]
        : "Kan ikke bekrefte status";
  return (
    <List.Item
      title={names[kind]}
      subtitle={status?.message || undefined}
      icon={kind === "atlas" ? Icon.Map : Icon.Book}
      accessories={[
        { text: state },
        ...(checked
          ? [
              {
                text: checked.toLocaleTimeString("nb-NO"),
                tooltip: "Siste statuskontroll",
              },
            ]
          : []),
      ]}
      actions={
        <ActionPanel>
          {!busy && !loading && status?.state === "ready" && (
            <Action
              title="Åpne"
              icon={Icon.Globe}
              onAction={() => perform("open")}
            />
          )}
          {!busy && !loading && status?.state === "stopped" && (
            <>
              <Action
                title="Start og åpne"
                icon={Icon.Play}
                onAction={() => perform("start", true)}
              />
              <Action
                title="Start uten å åpne"
                icon={Icon.Play}
                onAction={() => perform("start")}
              />
            </>
          )}
          {!busy && !loading && status?.state === "ready" && status.canStop && (
            <Action
              title="Stopp tjenesten"
              icon={Icon.Stop}
              onAction={() => perform("stop")}
            />
          )}
          <Action
            title="Oppdater status"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={refresh}
          />
          {status && (
            <Action
              title="Vis logg"
              icon={Icon.Document}
              onAction={() =>
                push(<LogView kind={kind} file={status.logPath} />)
              }
            />
          )}
          <Action
            title="Åpne innstillinger"
            icon={Icon.Gear}
            onAction={openExtensionPreferences}
          />
        </ActionPanel>
      }
    />
  );
}
export default function LocalServices() {
  const control = useMemo(() => new ServiceControl(getPreferenceValues()), []);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return (
    <List
      navigationTitle="Lokale tjenester"
      searchBarPlaceholder="Finn Turatlas eller Masteroppgaver"
    >
      {(["atlas", "library"] as const).map((kind) => (
        <ServiceRow
          key={kind}
          kind={kind}
          control={control}
          revision={revision}
          refresh={refresh}
        />
      ))}
    </List>
  );
}
