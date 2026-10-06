import { closeMainWindow, getPreferenceValues, Toast, environment, showToast } from "@raycast/api";
import { showFailureToast, useCachedState } from "@raycast/utils";

import { CachedDataParams, initialSync, SyncData, Task, updateTask } from "../api";
import { showFocusPanel, stopFocusPanel } from "../focus/panel";

/** Takes the cached data from the caller, so the hook doesn't parse the whole cache again for each task. */
export const useFocusedTask = ({ data, setData }: CachedDataParams) => {
  const { focusLabelName, showFocusWindow, focusDuration } = getPreferenceValues<Preferences>();

  const { commandMode } = environment;

  const [focusedTask, setFocusedTask] = useCachedState("todoist.focusedTask", { id: "", content: "" });

  async function clearFocusedTask() {
    if (!focusedTask.id) {
      return;
    }

    await stopFocusPanel(focusedTask.id);

    if (focusLabelName && focusLabelName.trim().length > 0) {
      if (commandMode === "view") {
        await showToast({ style: Toast.Style.Animated, title: "Removing focus label" });
      }

      // Need to sync the task before removing the label to avoid race condition.
      const syncData = (await initialSync()) as SyncData;
      const task = syncData.items.find((t) => t.id === focusedTask.id);

      if (task) {
        const labels = task.labels.filter((label) => label !== focusLabelName.trim());
        await updateTask({ id: focusedTask.id, labels }, { data: syncData, setData });
      }
    }

    setFocusedTask({ id: "", content: "" });

    if (commandMode === "view") {
      await showToast({ style: Toast.Style.Success, title: "No more focus" });
    }
  }

  async function unfocusTask() {
    try {
      await clearFocusedTask();
      return true;
    } catch (error) {
      await showFailureToast(error, { title: "Unable to unfocus task" });
      return false;
    }
  }

  async function focusTask({ id, content, labels }: Task) {
    try {
      if (focusedTask.id && focusedTask.id !== id && !(await unfocusTask())) return;
      if (focusLabelName && focusLabelName.trim().length > 0) {
        if (commandMode === "view") {
          await showToast({ style: Toast.Style.Animated, title: "Adding focus label" });
        }
        await updateTask({ id, labels: [...new Set([...labels, focusLabelName.trim()])] }, { data, setData });
      }
      // Preserve the full title; shortening belongs only in the menu bar renderer.
      setFocusedTask({ id, content });
      if (process.platform === "darwin" && showFocusWindow !== false) {
        await showFocusPanel({ id, content }, Number(focusDuration ?? "25"));
        if (commandMode === "view") await closeMainWindow();
      } else if (commandMode === "view") {
        await showToast({ style: Toast.Style.Success, title: `Focus on "${content}" 🎯` });
      }
    } catch (error) {
      await showFailureToast(error, { title: "Unable to focus task" });
    }
  }

  return { focusedTask, unfocusTask, focusTask };
};

export type FocusedTaskState = ReturnType<typeof useFocusedTask>;
