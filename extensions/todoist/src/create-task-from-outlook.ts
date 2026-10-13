import { launchCommand, LaunchType, showHUD } from "@raycast/api";

import { captureOutlookSelection } from "./helpers/outlook";

export default async function CreateTaskFromOutlook() {
  try {
    const outlookDraft = await captureOutlookSelection();
    await launchCommand({ name: "create-task", type: LaunchType.UserInitiated, context: { outlookDraft } });
  } catch (error) {
    // Do not log selected email content or silently reuse clipboard contents.
    const message = error instanceof Error ? error.message : "Kunne ikke lese e-posten.";
    const detail = /selected text/i.test(message)
      ? "Marker tekst i e-posten og prøv igjen."
      : /timed out|timeout|-1712/i.test(message)
        ? "Outlook svarte ikke i tide. Prøv igjen."
        : message;
    // Background deeplinks cannot use the Toast API. A HUD also makes failures
    // visible when Outlook remains in the foreground.
    await showHUD(`Kunne ikke hente fra Outlook: ${detail}`);
  }
}
