import { launchCommand, LaunchType, showToast, Toast } from "@raycast/api";

import { captureOutlookSelection } from "./helpers/outlook";

export default async function CreateTaskFromOutlook() {
  try {
    const outlookDraft = await captureOutlookSelection();
    await launchCommand({ name: "create-task", type: LaunchType.UserInitiated, context: { outlookDraft } });
  } catch (error) {
    // Do not log selected email content or silently reuse clipboard contents.
    const message = error instanceof Error ? error.message : "Kunne ikke lese e-posten.";
    await showToast({
      style: Toast.Style.Failure,
      title: "Kunne ikke hente fra Outlook",
      message: /selected text/i.test(message) ? "Marker tekst i e-posten og prøv igjen." : message,
    });
  }
}
