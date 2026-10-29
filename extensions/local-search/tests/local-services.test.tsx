import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { it, expect, vi, afterEach } from "vitest";
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  perform: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@raycast/api", () => {
  const part = (name: string) => (props: Record<string, unknown>) =>
    React.createElement(
      name,
      props,
      props.children as React.ReactNode,
      props.actions as React.ReactNode,
    );
  return {
    List: Object.assign(part("list"), { Item: part("item") }),
    Action: part("action"),
    ActionPanel: part("actions"),
    Detail: part("detail"),
    Icon: {},
    getPreferenceValues: () => ({}),
    Keyboard: {
      Shortcut: { Common: { Refresh: { modifiers: ["cmd"], key: "r" } } },
    },
    open: mocks.open,
    openExtensionPreferences: vi.fn(),
    showInFinder: vi.fn(),
    showToast: vi.fn(),
    Toast: { Style: { Failure: "failure" } },
    useNavigation: () => ({ push: vi.fn() }),
  };
});
vi.mock("../src/service-control", async () => {
  const actual = await vi.importActual<typeof import("../src/service-control")>(
    "../src/service-control",
  );
  return {
    ...actual,
    ServiceControl: class {
      status = mocks.status;
      perform = mocks.perform;
    },
  };
});
import LocalServices from "../src/local-services";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.clearAllMocks();
});
const status = (kind: string, state = "stopped") => ({
  version: 1,
  service: kind,
  state,
  url: null,
  logPath: "/tmp/synthetic.log",
  canStop: false,
});
it("loads rows independently and refreshes only status without starting services", async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.status.mockImplementation((kind) =>
    kind === "library"
      ? new Promise((r) => {
          finish = r;
        })
      : Promise.resolve(status(kind)),
  );
  await act(async () => {
    renderer = create(<LocalServices />);
  });
  let rows = renderer!.root.findAllByType("item");
  expect(rows[0].props.accessories[0].text).toBe("Stoppet");
  expect(rows[1].props.accessories[0].text).toBe("Kontrollerer");
  await act(async () =>
    finish({ ...status("library", "unknown"), message: "Mangler kjøretid" }),
  );
  rows = renderer!.root.findAllByType("item");
  expect(rows[1].props.subtitle).toBe("Mangler kjøretid");
  expect(
    rows[1].findAllByType("action").map((a) => a.props.title),
  ).not.toContain("Start og åpne");
  await act(async () =>
    rows[0]
      .findAllByType("action")
      .find((a) => a.props.title === "Oppdater status")!
      .props.onAction(),
  );
  expect(mocks.status).toHaveBeenCalledTimes(4);
  expect(mocks.perform).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});
it("suppresses repeated actions while a service operation is pending", async () => {
  mocks.status.mockImplementation((kind) => Promise.resolve(status(kind)));
  let finish: (value: unknown) => void = () => {};
  mocks.perform.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  await act(async () => {
    renderer = create(<LocalServices />);
  });
  const action = renderer!.root
    .findAllByType("item")[0]
    .findAllByType("action")
    .find((a) => a.props.title === "Start og åpne")!;
  let first: Promise<void>;
  await act(async () => {
    first = action.props.onAction();
    void action.props.onAction();
  });
  expect(mocks.perform).toHaveBeenCalledOnce();
  expect(
    renderer!.root.findAllByType("item")[0].props.accessories[0].text,
  ).toBe("Starter/stopper");
  await act(async () => {
    finish({ status: status("atlas") });
    await first!;
  });
});
