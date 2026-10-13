import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: vi.fn(),
  selected: vi.fn(),
  script: vi.fn(),
  launch: vi.fn(),
  hud: vi.fn(),
}));
vi.mock("@raycast/api", () => ({
  getFrontmostApplication: mocks.app,
  getSelectedText: mocks.selected,
  launchCommand: mocks.launch,
  LaunchType: { UserInitiated: "userInitiated" },
  showHUD: mocks.hud,
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
    expect(mocks.hud).not.toHaveBeenCalled();
  });

  it("refuses another app before reading any selection or Outlook header", async () => {
    mocks.app.mockResolvedValue({ bundleId: "com.apple.Safari" });
    await Command();
    expect(mocks.selected).not.toHaveBeenCalled();
    expect(mocks.script).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.hud).toHaveBeenCalledOnce();
  });

  it("uses the reading pane selection while Outlook's selection popup has focus", async () => {
    mocks.script.mockResolvedValue(
      JSON.stringify({
        ...header,
        focusedRole: "AXButton",
        focusedIdentifier: "WKWebviewAskCopilotButton",
        focusedDescription: "Forklar dette",
        selectedText: "Only the native selection",
      }),
    );
    await Command();
    expect(mocks.selected).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          outlookDraft: createOutlookDraft(header, "Only the native selection"),
        },
      }),
    );
  });

  it("does not replace a known empty native selection with another source", async () => {
    mocks.script.mockResolvedValue(JSON.stringify({ ...header, selectedText: "" }));
    await Command();
    expect(mocks.selected).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("rejects a changed native selection in the same email", async () => {
    mocks.script.mockResolvedValueOnce(JSON.stringify({ ...header, selectedText: "First selection" }));
    mocks.script.mockResolvedValueOnce(JSON.stringify({ ...header, selectedText: "Changed selection" }));
    await expect(captureOutlookSelection()).rejects.toThrow("Markeringen ble endret");
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

  it.each([null, "AXButton"])("rejects missing or unexpected focus (%s)", async (focusedRole) => {
    mocks.script.mockResolvedValue(JSON.stringify({ ...header, focusedRole }));
    await expect(captureOutlookSelection()).rejects.toThrow("e-postteksten");
    expect(mocks.selected).not.toHaveBeenCalled();
  });

  it("rejects focus moving out of the message while reading the selection", async () => {
    mocks.script.mockResolvedValueOnce(JSON.stringify(header));
    mocks.script.mockResolvedValueOnce(JSON.stringify({ ...header, focusedRole: "AXTextField" }));
    await Command();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.hud).toHaveBeenCalledWith(expect.stringContaining("e-postteksten"));
  });

  it.each(["", " \n\t "])("does not create a draft from empty selected text", async (text) => {
    mocks.selected.mockResolvedValue(text);
    await Command();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.hud).toHaveBeenCalledOnce();
  });

  it("does not fall back to stale clipboard contents if reading the selection fails", async () => {
    mocks.selected.mockRejectedValue(new Error("Unable to get selected text from frontmost application"));
    await Command();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.hud).toHaveBeenCalledWith("Kunne ikke hente fra Outlook: Marker tekst i e-posten og prøv igjen.");
  });

  it("shows a concise timeout in a HUD instead of the unavailable background Toast API", async () => {
    mocks.script.mockRejectedValue(new Error("Command timed out after undefined milliseconds: osascript"));
    await Command();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.hud).toHaveBeenCalledWith("Kunne ikke hente fra Outlook: Outlook svarte ikke i tide. Prøv igjen.");
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
    uiElements: () => [...descendants],
  };
}
function runHeaderScript(
  windows: AXNode[],
  options: { focused?: AXNode; frontmost?: boolean; nativeError?: string } = {},
) {
  const readingPane = node({ AXRole: "AXWebArea", AXDescription: "Reading Pane" });
  const nativeApplication = node({ AXFocusedUIElement: options.focused ?? readingPane, AXWindows: windows });
  // Returning the focused element through System Events is the live failure.
  const process = { windows: () => windows, frontmost: () => options.frontmost ?? true };
  const nativeAPI = Object.assign((value: unknown) => value, {
    NSRunningApplication: {
      runningApplicationsWithBundleIdentifier: (bundleId: string) => {
        expect(bundleId).toBe("com.microsoft.Outlook");
        return { firstObject: { processIdentifier: 123, active: options.frontmost ?? true } };
      },
    },
    AXUIElementCreateApplication: (pid: number) => {
      expect(pid).toBe(123);
      return nativeApplication;
    },
    AXUIElementSetMessagingTimeout: (_element: AXNode, seconds: number) => {
      expect(seconds).toBe(2);
      return 0;
    },
    AXUIElementCopyAttributeValue: (element: AXNode, name: string, result: unknown[]) => {
      if (name === options.nativeError) return -25204;
      result[0] = name === "AXChildren" ? element.uiElements() : element.attributes.byName(name).value();
      return 0;
    },
    AXUIElementCopyParameterizedAttributeValue: (element: AXNode, name: string, range: unknown, result: unknown[]) => {
      expect(name).toBe("AXStringForTextMarkerRange");
      expect(range).toBe(element.attributes.byName("AXSelectedTextMarkerRange").value());
      result[0] = element.attributes.byName("selectedMarkerText").value();
      return 0;
    },
  });
  return runInNewContext(`${outlookHeaderScript}\nrun()`, {
    ObjC: { import: () => {}, bindFunction: () => {}, unwrap: (value: unknown) => value },
    Ref: () => [],
    $: nativeAPI,
    Application: () => ({
      processes: { byName: () => process },
    }),
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
  const selectedPane = node({ AXRole: "AXWebArea", AXDescription: "Reading Pane", AXSelectedText: "Selected excerpt" });
  const messageWindow = node({ AXRole: "AXWindow", AXSubrole: "AXStandardWindow" }, [messageHeader, selectedPane]);
  const capturedHeader = { ...header, selectedText: "Selected excerpt", focusedIdentifier: null };

  it("reads only scalar focus properties without requesting an element reference from System Events", () => {
    expect(JSON.parse(runHeaderScript([messageWindow]))).toEqual(capturedHeader);
  });

  it.each(["AXFocusedUIElement", "AXRole"])("fails closed when native focus reading fails at %s", (nativeError) => {
    expect(() => runHeaderScript([messageWindow], { nativeError })).toThrow("e-postteksten");
  });

  it("reads the selected excerpt without pressing Escape or changing the popup focus", () => {
    const result = JSON.parse(
      runHeaderScript([messageWindow], {
        focused: node({
          AXRole: "AXButton",
          AXIdentifier: "WKWebviewAskCopilotButton",
          AXDescription: "Forklar dette",
        }),
      }),
    );
    expect(result).toEqual({
      ...capturedHeader,
      focusedRole: "AXButton",
      focusedIdentifier: "WKWebviewAskCopilotButton",
      focusedDescription: "Forklar dette",
    });
  });

  it("uses WebKit's selected text marker range when AXSelectedText is unavailable", () => {
    const markerPane = node({
      AXRole: "AXWebArea",
      AXDescription: "Reading Pane",
      AXSelectedTextMarkerRange: {},
      selectedMarkerText: "Marker excerpt",
    });
    markerPane.uiElements = () => {
      throw new Error("Must not inspect the whole message body");
    };
    const window = node({ AXRole: "AXWindow", AXSubrole: "AXStandardWindow" }, [messageHeader, markerPane]);
    expect(JSON.parse(runHeaderScript([window])).selectedText).toBe("Marker excerpt");
  });

  it.each([
    { role: "AXButton", identifier: "WKWebviewAskCopilotButton", frontmost: false },
    { role: "AXButton", identifier: "OtherButton", frontmost: true },
    { role: "AXTextField", identifier: "WKWebviewAskCopilotButton", frontmost: true },
    { role: null, identifier: null, frontmost: true },
  ])("rejects an unrelated focus or a background app: %j", ({ role, identifier, frontmost }) => {
    expect(() =>
      runHeaderScript([messageWindow], {
        focused: node({ AXRole: role, AXIdentifier: identifier }),
        frontmost,
      }),
    ).toThrow();
  });
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
    expect(result).toEqual({ ...capturedHeader, selectedText: null });
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
