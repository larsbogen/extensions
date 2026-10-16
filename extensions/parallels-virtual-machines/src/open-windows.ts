import { getPreferenceValues } from "@raycast/api";
import { openVM } from "./actions";

export default async function OpenWindowsCommand(): Promise<void> {
  await openVM(getPreferenceValues<Preferences.OpenWindows>().vmIdentifier);
}
