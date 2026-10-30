import { closeMainWindow, getPreferenceValues, Toast, environment, showToast } from "@raycast/api";
import { showFailureToast, useCachedState } from "@raycast/utils";

import { CachedDataParams, Task } from "../api";
import { clearFocusedTask, FocusedTask, startFocusedTask } from "../focus/service";

/** Reuses the caller's cache while all entry points share the same focus service. */
export const useFocusedTask = ({ data, setData }: CachedDataParams) => {
  const { showFocusWindow } = getPreferenceValues<Preferences>();
  const [focusedTask, setFocusedTask] = useCachedState<FocusedTask>("todoist.focusedTask", { id: "", content: "" });

  async function unfocusTask(options: { automatic?: boolean } = {}) {
    try {
      if (!(await clearFocusedTask({ data, setData }, options))) return false;
      setFocusedTask({ id: "", content: "" });
      if (environment.commandMode === "view") await showToast({ style: Toast.Style.Success, title: "No more focus" });
      return true;
    } catch (error) {
      await showFailureToast(error, { title: "Unable to unfocus task" });
      return false;
    }
  }

  async function focusTask(task: Task) {
    try {
      await startFocusedTask(task, { data, setData });
      setFocusedTask({ id: task.id, content: task.content, projectId: task.project_id });
      if (environment.commandMode === "view") {
        if (process.platform === "darwin" && showFocusWindow !== false) await closeMainWindow();
        else await showToast({ style: Toast.Style.Success, title: `Focus on "${task.content}" 🎯` });
      }
    } catch (error) {
      await showFailureToast(error, { title: "Unable to focus task" });
    }
  }

  return { focusedTask, unfocusTask, focusTask };
};

export type FocusedTaskState = ReturnType<typeof useFocusedTask>;
