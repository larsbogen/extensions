import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { it, expect, vi, afterEach } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn(), connect: vi.fn() }));
vi.mock("@raycast/api", () => {
  const part = (name: string) =>
    Object.assign(
      (props: Record<string, unknown>) =>
        React.createElement(name, props, props.children as React.ReactNode),
      {},
    );
  const Detail = Object.assign(part("detail"), {
    Metadata: Object.assign(part("metadata"), { Label: part("label") }),
  });
  const List = Object.assign(part("list"), {
    Item: Object.assign(part("item"), { Detail }),
    Section: part("section"),
    EmptyView: part("empty"),
  });
  return {
    Keyboard: {
      Shortcut: { Common: { Refresh: { modifiers: ["cmd"], key: "r" } } },
    },
    List,
    ActionPanel: part("actions"),
    Action: Object.assign(part("action"), {
      OpenInBrowser: part("browser"),
      SubmitForm: part("submit"),
    }),
    Form: part("form"),
    getPreferenceValues: () => ({}),
    useNavigation: () => ({ push: vi.fn(), pop: vi.fn() }),
    open: vi.fn(),
  };
});
vi.mock("../src/service", async () => {
  const actual =
    await vi.importActual<typeof import("../src/service")>("../src/service");
  return {
    ...actual,
    Services: class {
      connect = mocks.connect;
      searchAtlas = mocks.search;
    },
  };
});
import SearchAtlas from "../src/search-atlas";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});
const result = (id: string, total = 1) => ({
  baseUrl: "http://127.0.0.1:4317",
  data: {
    version: 1,
    items: [
      {
        id,
        title: id,
        kind: "Løping",
        day: null,
        distance: null,
        duration: null,
        routeStatus: "no-position",
        mediaCount: 0,
      },
    ],
    total,
    kinds: ["Løping"],
  },
});
it("gamle svar kan ikke erstatte nyere søk", async () => {
  vi.useFakeTimers();
  mocks.connect.mockResolvedValue({});
  const pending: ((v: unknown) => void)[] = [];
  mocks.search.mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  await act(async () => {
    renderer = create(<SearchAtlas />);
  });
  await act(async () => {
    renderer!.root.findByType("list").props.onSearchTextChange("ny");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(pending).toHaveLength(2);
  await act(async () => pending[1](result("nytt treff")));
  await act(async () => pending[0](result("gammelt treff")));
  expect(
    renderer!.root.findAllByType("item").map((i) => i.props.title),
  ).toEqual(["nytt treff"]);
});
it("legger neste side til uten duplikater", async () => {
  mocks.connect.mockResolvedValue({});
  mocks.search.mockResolvedValueOnce(result("a", 2)).mockResolvedValueOnce({
    ...result("b", 2),
    data: {
      ...result("b", 2).data,
      items: [result("a").data.items[0], result("b").data.items[0]],
    },
  });
  await act(async () => {
    renderer = create(<SearchAtlas />);
  });
  await act(async () =>
    renderer!.root.findByType("list").props.pagination.onLoadMore(),
  );
  expect(
    renderer!.root.findAllByType("item").map((i) => i.props.title),
  ).toEqual(["a", "b"]);
  expect(mocks.search.mock.calls[1][0].get("offset")).toBe("1");
});
