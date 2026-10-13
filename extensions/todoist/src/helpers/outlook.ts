import { getFrontmostApplication, getSelectedText } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";

// Read only the visible message header. Do not search folders, conversations or
// recipients for a fallback sender, and do not read the message body here.
export const outlookHeaderScript = `
function run() {
  const outlook = Application("System Events").processes.byName("Microsoft Outlook");
  function attr(element, name) {
    try { return element.attributes.byName(name).value(); } catch (_) { return null; }
  }
  function children(element) {
    try { return element.uiElements(); } catch (_) { return []; }
  }
  // A selection can put Outlook's small "Explain this" popover first in
  // windows(). Use the front standard window, not that floating button.
  const windows = outlook.windows().filter(element => attr(element, "AXSubrole") === "AXStandardWindow");
  if (windows.length === 0) throw new Error("Åpne en e-post i Outlook først.");
  const queue = [windows[0]];
  let header = null;
  let visited = 0;
  while (queue.length && visited++ < 250) {
    const element = queue.shift();
    if (attr(element, "AXIdentifier") === "HeaderMainContainer") {
      header = element;
      break;
    }
    const role = attr(element, "AXRole");
    if (["AXWindow", "AXGroup", "AXSplitGroup", "AXScrollArea"].includes(role)) {
      queue.push(...children(element));
    }
  }
  if (!header) throw new Error("Fant ikke meldingshodet. Åpne e-posten i leseruten eller et eget vindu.");
  const subject = children(header)
    .filter(element => attr(element, "AXRole") === "AXStaticText")
    .map(element => attr(element, "AXValue"))
    .find(value => typeof value === "string" && value.trim());
  const headerQueue = children(header);
  let sender = null;
  let senderName = null;
  let timestamp = null;
  visited = 0;
  while (headerQueue.length && visited++ < 100) {
    const element = headerQueue.shift();
    if (attr(element, "AXIdentifier") === "messageHeaderFromContent") {
      sender = attr(element, "AXValue");
    }
    if (attr(element, "AXIdentifier") === "messageHeaderPresenceView") senderName = attr(element, "AXDescription");
    if (attr(element, "AXIdentifier") === "messageHeaderTimeStampContent") timestamp = attr(element, "AXValue");
    headerQueue.push(...children(element));
  }
  const focused = attr(outlook, "AXFocusedUIElement");
  return JSON.stringify({ subject, sender, senderName, timestamp, focusedRole: attr(focused, "AXRole"), focusedDescription: attr(focused, "AXDescription") });
}
`;

export type OutlookHeader = {
  subject: string;
  sender: string;
  senderName?: string;
  timestamp?: string;
  focusedRole?: string;
  focusedDescription?: string;
};

export type OutlookTaskDraft = { content: string; description: string };

export function validateOutlookHeader(value: unknown): OutlookHeader {
  const header = value as Partial<OutlookHeader> | null;
  if (!header || typeof header.subject !== "string" || typeof header.sender !== "string" || !header.sender.trim()) {
    throw new Error("Kunne ikke lese både emne og avsender fra Outlook.");
  }
  return header as OutlookHeader;
}

export function createOutlookDraft(header: OutlookHeader, selection: string): OutlookTaskDraft {
  if (!selection.trim()) throw new Error("Marker tekst i e-posten først.");
  const rawSender = header.sender.replace(/^(?:Fra|From):\s*/i, "").trim();
  const email = rawSender.match(/[^\s,<>]+@[^\s,<>]+/);
  const name =
    header.senderName?.trim() || (email ? rawSender.slice(0, email.index).replace(/[\s,<]+$/, "") : rawSender);
  const sender = email ? `${name ? `${name} ` : ""}<${email[0]}>` : name;
  return {
    content: header.subject.trim() || "(Uten emne)",
    description: `Avsender: ${sender}\n\n${selection.trim()}`,
  };
}

export async function readOutlookHeader(): Promise<OutlookHeader> {
  const json = await runAppleScript<string>(outlookHeaderScript, { language: "JavaScript", timeout: 15000 });
  return validateOutlookHeader(JSON.parse(json));
}

export async function captureOutlookSelection(): Promise<OutlookTaskDraft> {
  const app = await getFrontmostApplication();
  if (app.bundleId !== "com.microsoft.Outlook") throw new Error("Åpne Outlook og marker tekst i e-posten først.");
  const before = await readOutlookHeader();
  if (before.focusedRole !== "AXWebArea" || before.focusedDescription !== "Reading Pane") {
    throw new Error("Klikk i e-postteksten og marker utdraget du vil bruke.");
  }
  const text = await getSelectedText();
  if (!text.trim()) throw new Error("Marker tekst i e-posten først.");
  const after = await readOutlookHeader();
  if (before.subject !== after.subject || before.sender !== after.sender || before.timestamp !== after.timestamp) {
    throw new Error("Meldingen ble endret under lesingen. Marker teksten og prøv igjen.");
  }
  return createOutlookDraft(after, text);
}
