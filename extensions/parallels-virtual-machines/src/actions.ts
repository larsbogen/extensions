import { Alert, closeMainWindow, confirmAlert, open, openCommandPreferences, showToast, Toast } from "@raycast/api";
import { ParallelsError, ParallelsService, PARALLELS_BUNDLE_ID } from "./service";
import { VM, VMAction } from "./types";

export const parallels = new ParallelsService({
  openFile: async (path) => {
    await closeMainWindow();
    await open(path, PARALLELS_BUNDLE_ID);
  },
});

export async function showOperationFailure(error: unknown, title = "Parallels operation failed"): Promise<void> {
  await showToast({
    style: Toast.Style.Failure,
    title,
    message: error instanceof Error ? error.message : String(error),
    primaryAction:
      error instanceof ParallelsError && error.code === "selection"
        ? {
            title: "Open Command Settings",
            onAction: async () => {
              await openCommandPreferences();
            },
          }
        : undefined,
  });
}

async function withFeedback(
  title: string,
  operation: (progress: (message: string) => void) => Promise<void>,
): Promise<boolean> {
  const toast = await showToast({ style: Toast.Style.Animated, title });
  try {
    await operation((message) => {
      toast.message = message;
    });
    toast.style = Toast.Style.Success;
    toast.title = "Parallels operation completed";
    toast.message = "";
    return true;
  } catch (error) {
    await toast.hide();
    await showOperationFailure(error, title.replace(/…$/, " failed"));
    return false;
  }
}

export async function openVM(identifier: string): Promise<boolean> {
  return withFeedback("Opening virtual machine…", async (progress) => {
    const vm = await parallels.openVM(identifier, progress);
    progress(`${vm.name} is running`);
  });
}

const actionTitles: Record<VMAction, string> = {
  [VMAction.Suspend]: "Suspending virtual machine…",
  [VMAction.Stop]: "Shutting down virtual machine…",
  [VMAction.ForceStop]: "Force stopping virtual machine…",
  [VMAction.Reset]: "Resetting virtual machine…",
};

export async function runVMAction(vm: VM, action: VMAction): Promise<boolean> {
  if (action === VMAction.ForceStop || action === VMAction.Reset) {
    const label = action === VMAction.Reset ? "Reset" : "Force Stop";
    const confirmed = await confirmAlert({
      title: `${label} “${vm.name}”?`,
      message: "This immediately interrupts the virtual machine. Unsaved work may be lost.",
      primaryAction: { title: label, style: Alert.ActionStyle.Destructive },
      dismissAction: { title: "Cancel" },
    });
    if (!confirmed) return false;
  }
  return withFeedback(actionTitles[action], async (progress) => {
    await parallels.controlVM(vm.id, action, progress);
  });
}

export async function quitDesktop(): Promise<boolean> {
  return withFeedback("Quitting Parallels Desktop…", async () => {
    await parallels.quitDesktop();
  });
}
