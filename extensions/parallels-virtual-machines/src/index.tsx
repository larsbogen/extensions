import { ActionPanel, Action, List, Icon } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useRef, useState } from "react";
import { VM, VMState, VMAction } from "./types";
import { parallels, openVM, runVMAction, showOperationFailure } from "./actions";
import { stateToDescription, iconForVM } from "./utils";

export default function Command() {
  const {
    data: vms = [],
    isLoading,
    error,
    revalidate,
  } = usePromise(() => parallels.listVMs(), [], {
    onError: async (error) => {
      await showOperationFailure(error, "Could not load virtual machines");
    },
  });
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  async function perform(operation: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await operation();
    } finally {
      pending.current = false;
      setBusy(false);
      await revalidate();
    }
  }

  const refresh = (
    <Action
      title="Refresh Virtual Machines"
      icon={Icon.ArrowClockwise}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
      onAction={async () => {
        await revalidate();
      }}
    />
  );

  return (
    <List
      isLoading={isLoading || busy}
      searchBarPlaceholder="Search virtual machines..."
      actions={<ActionPanel>{refresh}</ActionPanel>}
    >
      <List.EmptyView
        title={error ? "Could Not Load Virtual Machines" : "No Virtual Machines"}
        description={error ? error.message : "Register a virtual machine in Parallels, then refresh."}
        icon={error ? Icon.ExclamationMark : Icon.Desktop}
      />
      <List.Section title="All Virtual Machines" subtitle={String(vms.length)}>
        {vms.map((vm) => (
          <VMItem key={vm.id} vm={vm} perform={perform} refresh={refresh} busy={busy} />
        ))}
      </List.Section>
    </List>
  );
}

function VMItem({
  vm,
  perform,
  refresh,
  busy,
}: {
  vm: VM;
  perform: (operation: () => Promise<unknown>) => Promise<void>;
  refresh: React.ReactNode;
  busy: boolean;
}) {
  const active = vm.state === VMState.Running || vm.state === VMState.Paused;
  const canOpen = [
    VMState.Running,
    VMState.Stopped,
    VMState.Suspended,
    VMState.Paused,
    VMState.Starting,
    VMState.Resuming,
  ].includes(vm.state);
  const title =
    vm.state === VMState.Stopped
      ? "Start and Open"
      : [VMState.Paused, VMState.Suspended].includes(vm.state)
        ? "Resume and Open"
        : "Open";

  return (
    <List.Item
      id={vm.id}
      title={vm.name}
      subtitle={stateToDescription(vm.state, vm.rawState)}
      icon={iconForVM(vm)}
      keywords={[vm.description, vm.os]}
      actions={
        <ActionPanel>
          {!busy && (
            <ActionPanel.Section>
              {canOpen && <Action title={title} icon={Icon.Window} onAction={() => perform(() => openVM(vm.id))} />}
              {active && (
                <Action
                  title="Suspend"
                  icon={Icon.Pause}
                  onAction={() => perform(() => runVMAction(vm, VMAction.Suspend))}
                />
              )}
              {vm.state === VMState.Running && (
                <Action
                  title="Shut Down VM"
                  icon={Icon.Power}
                  onAction={() => perform(() => runVMAction(vm, VMAction.Stop))}
                />
              )}
            </ActionPanel.Section>
          )}
          <ActionPanel.Section>{refresh}</ActionPanel.Section>
          {!busy && active && (
            <ActionPanel.Section title="Force Controls — Unsaved Work May Be Lost">
              <Action
                title="Force Stop"
                icon={Icon.Power}
                style={Action.Style.Destructive}
                onAction={() => perform(() => runVMAction(vm, VMAction.ForceStop))}
              />
              <Action
                title="Reset"
                icon={Icon.ArrowClockwise}
                style={Action.Style.Destructive}
                onAction={() => perform(() => runVMAction(vm, VMAction.Reset))}
              />
            </ActionPanel.Section>
          )}
        </ActionPanel>
      }
    />
  );
}
