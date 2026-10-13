import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: vi.fn(),
  selected: vi.fn(),
  script: vi.fn(),
  launch: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@raycast/api", () => ({
  getFrontmostApplication: mocks.app,
  getSelectedText: mocks.selected,
  launchCommand: mocks.launch,
  LaunchType: { UserInitiated: "userInitiated" },
  showToast: mocks.toast,
  Toast: { Style: { Failure: "failure" } },
}));
vi.mock("@raycast/utils", () => ({ runAppleScript: mocks.script }));

import Command from "../src/create-task-from-outlook";
import {
  captureOutlookSelection,
  createOutlookDraft,
  outlookHeaderScript,
  validateOutlookHeader,
} from "../src/helpers/outlook";

const header = {
  subject: "Re: Friday p1 #Budget @finance",
  sender: "Fra: Åse Hansen, ase@example.org, Borte",
  senderName: "Åse Hansen",
  timestamp: "13.10.2026 10:00",
  focusedRole: "AXWebArea",
  focusedDescription: "Reading Pane",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.app.mockResolvedValue({ bundleId: "com.microsoft.Outlook" });
  mocks.selected.mockResolvedValue("Første linje.\n\nNeste linje 😊");
  mocks.script.mockResolvedValue(JSON.stringify(header));
});

describe("Outlook selection capture", () => {
  it("prepares the exact subject, sender identity and only the selected excerpt for review", async () => {
    await Command();
    expect(mocks.launch).toHaveBeenCalledWith({
      name: "create-task",
      type: "userInitiated",
      context: {
        outlookDraft: {
          content: header.subject,
          description: "Avsender: Åse Hansen <ase@example.org>\n\nFørste linje.\n\nNeste linje 😊",
        },
      },
    });
    expect(mocks.selected).toHaveBeenCalledOnce();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("refuses another app before reading any selection or Outlook header", async () => {
    mocks.app.mockResolvedValue({ bundleId: "com.apple.Safari" });
    await Command();
    expect(mocks.selected).not.toHaveBeenCalled();
    expect(mocks.script).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("rejects selection in Outlook's search field", async () => {
    mocks.script.mockResolvedValue(JSON.stringify({ ...header, focusedRole: "AXTextField" }));
    await expect(captureOutlookSelection()).rejects.toThrow("e-postteksten");
    expect(mocks.selected).not.toHaveBeenCalled();
  });

  it("rejects selection in an add-in web view", async () => {
    mocks.script.mockResolvedValue(JSON.stringify({ ...header, focusedDescription: "An add-in" }));
    await expect(captureOutlookSelection()).rejects.toThrow("e-postteksten");
  });

  it.each(["", " \n\t "])("does not create a draft from empty selected text", async (text) => {
    mocks.selected.mockResolvedValue(text);
    await Command();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("does not fall back to stale clipboard contents if reading the selection fails", async () => {
    mocks.selected.mockRejectedValue(new Error("Unable to get selected text from frontmost application"));
    await Command();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Marker tekst i e-posten og prøv igjen." }),
    );
  });

  it("rejects a changed message even if its subject stays the same", async () => {
    mocks.script.mockResolvedValueOnce(JSON.stringify(header));
    mocks.script.mockResolvedValueOnce(JSON.stringify({ ...header, timestamp: "14.10.2026 10:00" }));
    await expect(captureOutlookSelection()).rejects.toThrow("endret");
  });

  it.each([null, {}, { subject: "Subject", sender: null }, { subject: "Subject", sender: " " }])(
    "rejects incomplete metadata instead of creating a task with a guessed sender",
    (value) => expect(() => validateOutlookHeader(value)).toThrow(),
  );

  it("supports an English sender field and preserves commas in the sender's name", () => {
    const draft = createOutlookDraft(
      { subject: " Subject ", sender: "From: Hansen, Åse, ase+work@example.org, Available" },
      "Text",
    );
    expect(draft).toEqual({ content: "Subject", description: "Avsender: Hansen, Åse <ase+work@example.org>\n\nText" });
  });

  it("uses a visible name if there is no email address and gives an empty subject an editable placeholder", () => {
    expect(createOutlookDraft({ subject: "", sender: "Fra: Åse Hansen", senderName: "Åse Hansen" }, "Text")).toEqual({
      content: "(Uten emne)",
      description: "Avsender: Åse Hansen\n\nText",
    });
  });
});

type AXNode = ReturnType<typeof node>;
function node(attributes: Record<string, unknown>, descendants: AXNode[] = []) {
  return {
    attributes: { byName: (name: string) => ({ value: () => attributes[name] ?? null }) },
    uiElements: () => descendants,
  };
}
function runHeaderScript(windows: AXNode[]) {
  const focused = node({ AXRole: "AXWebArea", AXDescription: "Reading Pane" });
  const process = { ...node({ AXFocusedUIElement: focused }), windows: () => windows };
  return runInNewContext(`${outlookHeaderScript}\nrun()`, {
    Application: () => ({ processes: { byName: () => process } }),
  });
}

describe("Outlook header traversal", () => {
  const messageHeader = node({ AXRole: "AXGroup", AXIdentifier: "HeaderMainContainer" }, [
    node({ AXRole: "AXStaticText", AXValue: header.subject }),
    node({ AXRole: "AXScrollArea" }, [
      node({ AXIdentifier: "messageHeaderFromContent", AXValue: header.sender }),
      node({ AXIdentifier: "messageHeaderPresenceView", AXDescription: header.senderName }),
      node({ AXIdentifier: "messageHeaderTimeStampContent", AXValue: header.timestamp }),
      node({ AXIdentifier: "messageHeaderRecipientsContent", AXValue: "Another Person <other@example.org>" }),
    ]),
  ]);
  it("ignores the selection popover, folder list and body, and reads the sender from the visible header", () => {
    const folderList = node({ AXRole: "AXOutline" });
    folderList.uiElements = () => {
      throw new Error("Must not inspect folders");
    };
    const body = node({ AXRole: "AXWebArea" });
    body.uiElements = () => {
      throw new Error("Must not inspect the whole message body");
    };
    const result = JSON.parse(
      runHeaderScript([
        node({ AXRole: "AXWindow", AXSubrole: "AXUnknown" }, [node({ AXRole: "AXButton" })]),
        node({ AXRole: "AXWindow", AXSubrole: "AXStandardWindow" }, [
          node({ AXRole: "AXSplitGroup" }, [folderList, body, messageHeader]),
        ]),
      ]),
    );
    expect(result).toEqual(header);
  });

  it("does not use a background email if the front standard window has no message header", () => {
    expect(() =>
      runHeaderScript([
        node({ AXRole: "AXWindow", AXSubrole: "AXStandardWindow" }),
        node({ AXRole: "AXWindow", AXSubrole: "AXStandardWindow" }, [messageHeader]),
      ]),
    ).toThrow("meldingshodet");
  });
});
