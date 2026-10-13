import { getFrontmostApplication, getSelectedText } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";

// Read only the visible message header. Do not search folders, conversations or
// recipients for a fallback sender, and do not read the message body here.
export const outlookHeaderScript = `
function run() {
  // System Events can recurse indefinitely when turning Outlook's focused
  // popover into an Apple-event object reference. Keep that element native and
  // only return scalar focus properties; the message header still uses JXA.
  ObjC.import("AppKit");
  ObjC.import("ApplicationServices");
  ObjC.bindFunction("AXUIElementCreateApplication", ["id", ["int"]]);
  ObjC.bindFunction("AXUIElementCopyAttributeValue", ["int", ["id", "id", "id*"]]);
  ObjC.bindFunction("AXUIElementCopyParameterizedAttributeValue", ["int", ["id", "id", "id", "id*"]]);
  ObjC.bindFunction("AXUIElementSetMessagingTimeout", ["int", ["id", "float"]]);
  const runningOutlook = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.microsoft.Outlook").firstObject;
  const nativeOutlook = $.AXUIElementCreateApplication(runningOutlook.processIdentifier);
  function nativeAttr(element, name) {
    if (!element) return null;
    $.AXUIElementSetMessagingTimeout(element, 2);
    const result = Ref();
    if ($.AXUIElementCopyAttributeValue(element, $(name), result) !== 0) return null;
    return result[0];
  }
  function focusInfo() {
    const focused = nativeAttr(nativeOutlook, "AXFocusedUIElement");
    return {
      role: ObjC.unwrap(nativeAttr(focused, "AXRole")),
      identifier: ObjC.unwrap(nativeAttr(focused, "AXIdentifier")),
      description: ObjC.unwrap(nativeAttr(focused, "AXDescription"))
    };
  }
  function readSelection() {
    const windows = ObjC.unwrap(nativeAttr(nativeOutlook, "AXWindows")) || [];
    const window = windows.find(element => ObjC.unwrap(nativeAttr(element, "AXSubrole")) === "AXStandardWindow");
    const queue = window ? [window] : [];
    let visited = 0;
    while (queue.length && visited++ < 250) {
      const element = queue.shift();
      const role = ObjC.unwrap(nativeAttr(element, "AXRole"));
      if (role === "AXWebArea" && ObjC.unwrap(nativeAttr(element, "AXDescription")) === "Reading Pane") {
        const selected = ObjC.unwrap(nativeAttr(element, "AXSelectedText"));
        if (typeof selected === "string") return selected;
        const range = nativeAttr(element, "AXSelectedTextMarkerRange");
        const result = Ref();
        if (range && $.AXUIElementCopyParameterizedAttributeValue(element, $("AXStringForTextMarkerRange"), range, result) === 0) {
          const text = ObjC.unwrap(result[0]);
          if (typeof text === "string") return text;
        }
        return null;
      }
      if (["AXWindow", "AXGroup", "AXSplitGroup", "AXScrollArea"].includes(role)) {
        queue.push(...(ObjC.unwrap(nativeAttr(element, "AXChildren")) || []));
      }
    }
    return null;
  }
  const systemEvents = Application("System Events");
  const outlook = systemEvents.processes.byName("Microsoft Outlook");
  function attr(element, name) {
    try { return element.attributes.byName(name).value(); } catch (_) { return null; }
  }
  function children(element) {
    try { return element.uiElements(); } catch (_) { return []; }
  }
  // Read the selection in place. Outlook may focus its "Explain this" button;
  // Escape or changing focus can clear the selection or deselect the message.
  const selectionFocus = focusInfo();
  if (!runningOutlook.active) throw new Error("Åpne Outlook og marker tekst i e-posten først.");
  if (!(selectionFocus.role === "AXWebArea" && selectionFocus.description === "Reading Pane") &&
      !(selectionFocus.role === "AXButton" && selectionFocus.identifier === "WKWebviewAskCopilotButton")) {
    throw new Error("Klikk i e-postteksten og marker utdraget du vil bruke.");
  }
  const selectedText = readSelection();
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
  const focused = focusInfo();
  return JSON.stringify({ subject, sender, senderName, timestamp, selectedText, focusedRole: focused.role, focusedDescription: focused.description, focusedIdentifier: focused.identifier });
}
`;

export type OutlookHeader = {
  subject: string;
  sender: string;
  senderName?: string;
  timestamp?: string;
  focusedRole?: string;
  focusedDescription?: string;
  focusedIdentifier?: string;
  selectedText?: string | null;
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
  if (!hasMessageFocus(before)) {
    throw new Error("Klikk i e-postteksten og marker utdraget du vil bruke.");
  }
  const text = before.selectedText ?? (await getSelectedText());
  if (!text.trim()) throw new Error("Marker tekst i e-posten først.");
  const after = await readOutlookHeader();
  if (!hasMessageFocus(after)) {
    throw new Error("Klikk i e-postteksten og marker utdraget du vil bruke.");
  }
  if (before.subject !== after.subject || before.sender !== after.sender || before.timestamp !== after.timestamp) {
    throw new Error("Meldingen ble endret under lesingen. Marker teksten og prøv igjen.");
  }
  if (typeof after.selectedText === "string" && after.selectedText.trim() !== text.trim()) {
    throw new Error("Markeringen ble endret under lesingen. Marker teksten og prøv igjen.");
  }
  return createOutlookDraft(after, text);
}

function hasMessageFocus(header: OutlookHeader): boolean {
  return (
    (header.focusedRole === "AXWebArea" && header.focusedDescription === "Reading Pane") ||
    (header.focusedRole === "AXButton" && header.focusedIdentifier === "WKWebviewAskCopilotButton")
  );
}
