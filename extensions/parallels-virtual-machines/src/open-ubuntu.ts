import { getPreferenceValues } from "@raycast/api";
import { openVM } from "./actions";

export default async function OpenUbuntuCommand(): Promise<void> {
  await openVM(getPreferenceValues<Preferences.OpenUbuntu>().vmIdentifier);
}
