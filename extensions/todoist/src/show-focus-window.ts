import { Cache, closeMainWindow, getPreferenceValues, showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";

import { showFocusPanel, showPendingFocusPanel } from "./focus/panel";

export default async function command() {
  try {
    const raw = new Cache().get("todoist.focusedTask");
    const task = raw ? JSON.parse(raw) : undefined;
    if (!task?.id || !task?.content) {
      if (await showPendingFocusPanel()) {
        await closeMainWindow();
        return;
      }
      await showToast({ style: Toast.Style.Failure, title: "Velg «Focus Task» på en oppgave først" });
      return;
    }
    const { focusDuration } = getPreferenceValues<Preferences>();
    await showFocusPanel(task, Number(focusDuration ?? "25"));
    await closeMainWindow();
  } catch (error) {
    await showFailureToast(error, { title: "Kunne ikke åpne fokusvinduet" });
  }
}
