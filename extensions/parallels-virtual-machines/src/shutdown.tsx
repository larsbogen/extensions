import { quitDesktop } from "./actions";

export default async function ShutdownCommand(): Promise<void> {
  await quitDesktop();
}
