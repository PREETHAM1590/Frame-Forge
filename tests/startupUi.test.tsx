// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Startup, filterItems } from "../src/views/Startup";
import type { StartupItem, StartupStatus } from "../shared/contracts";
import type { ViewProps } from "../src/types";

const item = (over: Partial<StartupItem>): StartupItem => ({
  id: "hkcu-run|Discord",
  name: "Discord",
  command: "C:\\d.exe",
  path: "C:\\d.exe",
  publisher: "Discord Inc.",
  source: "hkcu-run",
  scope: "user",
  enabled: true,
  canToggle: true,
  sizeBytes: 3_000_000,
  impact: "low",
  critical: false,
  criticalReason: null,
  approved: null,
  note: null,
  ...over,
});
const items = [
  item({}),
  item({
    id: "hkcu-run|Steam",
    name: "Steam",
    publisher: "Valve",
    enabled: false,
    approved: "030000000000000000000000",
  }),
  item({
    id: "hklm-run|SecurityHealth",
    name: "SecurityHealth",
    source: "hklm-run",
    scope: "machine",
    critical: true,
    criticalReason: "Security software or Windows Security.",
    publisher: "Microsoft",
  }),
  item({
    id: "task|\\Updater",
    name: "\\Updater",
    source: "task",
    canToggle: false,
    enabled: true,
  }),
];
let status: StartupStatus;
const calls: Array<[string, unknown]> = [];
const run = vi.fn(async (method: string, input: unknown) => {
  calls.push([method, input]);
  return status;
});
const props = {
  data: {
    activity: [
      {
        id: "1",
        label: "Startup program disabled",
        at: "2026-10-15T10:00:00Z",
        status: "success",
        message: "Steam disabled.",
        ids: [],
        rollback: false,
      },
    ],
  },
  run,
} as unknown as ViewProps;
const desktop = (api: unknown) =>
  ((window as unknown as { frameforge: unknown }).frameforge = api);
beforeEach(() => {
  calls.length = 0;
  status = {
    items,
    warnings: [],
    changes: [
      { id: "hkcu-run|Steam", name: "Steam", at: "2026-10-15T10:00:00Z" },
    ],
    message: "",
  };
  desktop({ startupList: async () => status });
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { frameforge?: unknown }).frameforge;
});

describe("filterItems", () => {
  it("filters by state and searches name, publisher and path", () => {
    expect(filterItems(items, "enabled", "").map((i) => i.name)).toEqual([
      "Discord",
      "SecurityHealth",
      "\\Updater",
    ]);
    expect(filterItems(items, "disabled", "").map((i) => i.name)).toEqual([
      "Steam",
    ]);
    expect(filterItems(items, "all", "valve").map((i) => i.name)).toEqual([
      "Steam",
    ]);
    expect(filterItems(items, "all", "zzz")).toEqual([]);
  });
});

describe("Startup page", () => {
  it("lists items with publisher, source, estimate label and listed-only state", async () => {
    render(<Startup {...props} />);
    expect(await screen.findByText("Discord")).toBeInTheDocument();
    expect(screen.getByText(/Valve/)).toBeInTheDocument();
    expect(screen.getAllByText(/Est\. impact: low/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Listed only/)).toBeInTheDocument();
    expect(screen.getByText("Protected")).toBeInTheDocument();
    expect(screen.getByText("Needs admin")).toBeInTheDocument();
    expect(screen.getByText(/Steam disabled\./)).toBeInTheDocument();
  });
  it("turns an item off and offers undo only where Frameforge changed it", async () => {
    render(<Startup {...props} />);
    fireEvent.click(
      await screen.findByRole("switch", { name: /Discord starts/ }),
    );
    await waitFor(() =>
      expect(calls[0]).toEqual([
        "startupSet",
        { id: "hkcu-run|Discord", enabled: false },
      ]),
    );
    expect(
      screen.getAllByRole("button", { name: /Undo change to/ }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Undo change to Steam" }),
    );
    await waitFor(() =>
      expect(calls.at(-1)).toEqual(["startupUndo", { id: "hkcu-run|Steam" }]),
    );
  });
  it("warns before turning off a protected item, then allows it", async () => {
    render(<Startup {...props} />);
    fireEvent.click(
      await screen.findByRole("switch", { name: /SecurityHealth starts/ }),
    );
    expect(
      await screen.findByText(/This is a warning, not a block/),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Turn off anyway" }));
    await waitFor(() =>
      expect(calls[0]).toEqual([
        "startupSet",
        { id: "hklm-run|SecurityHealth", enabled: false, acknowledged: true },
      ]),
    );
  });
  it("filters and searches", async () => {
    render(<Startup {...props} />);
    await screen.findByText("Discord");
    fireEvent.click(screen.getByRole("button", { name: /Disabled/ }));
    expect(screen.queryByText("Discord")).not.toBeInTheDocument();
    expect(screen.getByText("Steam")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByLabelText("Search startup apps"), {
      target: { value: "valve" },
    });
    expect(screen.queryByText("Discord")).not.toBeInTheDocument();
    expect(screen.getByText("Steam")).toBeInTheDocument();
  });
  it("shows an error with Retry when the list cannot be read", async () => {
    desktop({
      startupList: async () => {
        throw new Error("Helper missing");
      },
    });
    render(<Startup {...props} />);
    expect(await screen.findByText("Helper missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
