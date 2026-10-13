// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "../src/App";
import {
  defaultState,
  type AppState,
  type FrameforgeApi,
  type RestorePoints,
} from "../shared/contracts";
const status = {
  protection: "enabled" as const,
  policyDisabled: false,
  configLocked: false,
  frequency: { existed: false, minutes: null },
  elevated: false,
  systemDrive: "C:",
  lastAppCreatedAt: null,
  pendingFrequencyRecovery: false,
  pendingCreation: false,
  message: "System Protection is on.",
  systemDriveConfirmedAt: null,
};
const noPoints = (extra: Partial<RestorePoints>): RestorePoints => ({
  points: [],
  available: false,
  message: "Administrator approval was declined. Nothing was changed.",
  createdSequence: null,
  ...extra,
});
type SaveInput = { id?: string; name: string; ids: never[] };
// A fake preload API: no real helper, so no UAC prompt can ever appear.
function install(state: AppState = defaultState) {
  const store = { state: structuredClone(state) };
  const pending: {
    resolve: (v: RestorePoints) => void;
    reject: (e: Error) => void;
  }[] = [];
  const api = {
    bootstrap: async () => ({
      state: structuredClone(store.state),
      hardware: {
        source: "windows",
        collectedAt: "2026-01-01T00:00:00.000Z",
        cpu: "CPU",
        gpu: [],
        memoryBytes: 1,
        freeMemoryBytes: 1,
        cores: 1,
        os: "Windows",
        drives: [],
        displays: [],
        drivers: [],
        warnings: [],
      },
      activity: [],
      backups: [],
      capabilities: ["mouse-precision"],
      startupSupported: false,
      version: "test",
      mode: "desktop",
      boost: { session: null, available: true, watching: false },
    }),
    onEvent: () => () => {},
    restoreStatus: async () => status,
    restorePoints: vi.fn(
      () =>
        new Promise<RestorePoints>((resolve, reject) =>
          pending.push({ resolve, reject }),
        ),
    ),
    openSystemRestore: vi.fn(async () => true),
    savePreset: vi.fn(async (input: SaveInput) => {
      const id = input.id ?? crypto.randomUUID();
      store.state.presets = input.id
        ? store.state.presets.map((p) => (p.id === id ? { ...input, id } : p))
        : [...store.state.presets, { ...input, id }];
      return store.state;
    }),
    removePreset: vi.fn(async ({ id }: { id: string }) => {
      store.state.presets = store.state.presets.filter((p) => p.id !== id);
      return store.state;
    }),
  };
  window.frameforge = api as unknown as FrameforgeApi;
  return { api, pending };
}
beforeEach(() => {
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});
const goRestore = async () => {
  await screen.findByText("Your setup, in focus.");
  fireEvent.click(screen.getByRole("button", { name: "Restore & backups" }));
  await screen.findByText(/System Protection is on/);
};
const confirmElevation = async () =>
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Continue to administrator prompt",
    }),
  );
describe("elevated restore actions", () => {
  it("warns about the administrator prompt before listing and does nothing on Cancel", async () => {
    const { api } = install();
    render(<App />);
    await goRestore();
    fireEvent.click(
      screen.getByRole("button", { name: "Load restore points" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/administrator prompt \(UAC\)/);
    expect(dialog).toHaveTextContent(/only lets administrators list/);
    expect(api.restorePoints).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.restorePoints).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("only locks restore actions while waiting, then shows the neutral declined notice", async () => {
    const { api, pending } = install();
    render(<App />);
    await goRestore();
    fireEvent.click(
      screen.getByRole("button", { name: "Load restore points" }),
    );
    await confirmElevation();
    expect(
      await screen.findByText("Waiting for administrator approval…"),
    ).toBeVisible();
    expect(api.restorePoints).toHaveBeenCalledTimes(1);
    for (const name of [
      "Load restore points",
      "Create restore point",
      "Open Windows System Restore",
    ])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    // The rest of the app stays usable: other controls, navigation and other pages.
    expect(screen.getByRole("button", { name: "Create backup" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Refresh system readings" }),
    ).toBeEnabled();
    expect(screen.queryByText("Working")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Presets" }));
    expect(
      await screen.findByRole("button", { name: /Custom preset/ }),
    ).toBeEnabled();
    expect(
      screen.getAllByRole("button", { name: /Review preset/ })[0],
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Restore & backups" }));
    expect(
      await screen.findByText("Waiting for administrator approval…"),
    ).toBeVisible();
    pending[0].resolve(noPoints({ cancelled: true }));
    // The page that asked is gone, so the answer arrives as a neutral (non-error) toast.
    const toast = await screen.findByText(/approval was declined/);
    expect(toast.closest(".toast")).not.toHaveClass("error");
    expect(
      screen.queryByText("Waiting for administrator approval…"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Load restore points" }),
    ).toBeEnabled();
  });
  it("shows the neutral declined notice inline when the page is still open", async () => {
    const { pending } = install();
    render(<App />);
    await goRestore();
    fireEvent.click(
      screen.getByRole("button", { name: "Load restore points" }),
    );
    await confirmElevation();
    await screen.findByText("Waiting for administrator approval…");
    pending[0].resolve(noPoints({ cancelled: true }));
    const inline = (await screen.findAllByText(/approval was declined/)).find(
      (el) => el.closest(".notice"),
    );
    expect(inline!.closest(".notice")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("returns to normal with a clear message when the elevated request times out", async () => {
    const { pending } = install();
    render(<App />);
    await goRestore();
    fireEvent.click(
      screen.getByRole("button", { name: "Load restore points" }),
    );
    await confirmElevation();
    await screen.findByText("Waiting for administrator approval…");
    pending[0].reject(new Error("Windows helper timed out."));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /did not get an administrator answer in time/,
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Waiting for administrator approval…"),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Load restore points" }),
    ).toBeEnabled();
  });
  it("asks before opening Windows System Restore", async () => {
    const { api } = install();
    render(<App />);
    await goRestore();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Windows System Restore" }),
    );
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      /administrator prompt/,
    );
    expect(api.openSystemRestore).not.toHaveBeenCalled();
    await confirmElevation();
    await waitFor(() => expect(api.openSystemRestore).toHaveBeenCalledTimes(1));
  });
});
describe("custom presets", () => {
  const preset = {
    id: crypto.randomUUID(),
    name: "My preset",
    ids: ["mouse-precision" as const],
  };
  const open = async () => {
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Presets" }));
    await screen.findByRole("heading", { name: "My preset" });
  };
  it("edits a saved preset in place by id", async () => {
    const { api } = install({ ...defaultState, presets: [preset] });
    render(<App />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Edit My preset" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Preset name");
    expect(name).toHaveValue("My preset");
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(
      within(dialog).getByLabelText(/Disable background game capture/),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save preset" }),
    );
    await waitFor(() =>
      expect(api.savePreset).toHaveBeenCalledWith({
        id: preset.id,
        name: "Renamed",
        ids: ["mouse-precision", "capture-off"],
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Renamed" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "My preset" })).toBeNull();
  });
  it("blocks a name that clashes case-insensitively with a clear message", async () => {
    const { api } = install({ ...defaultState, presets: [preset] });
    render(<App />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^Custom preset/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Preset name"), {
      target: { value: "  MY PRESET " },
    });
    fireEvent.click(
      within(dialog).getByLabelText(/Disable background game capture/),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      /already exists. Choose a different name/,
    );
    expect(
      within(dialog).getByRole("button", { name: "Save preset" }),
    ).toBeDisabled();
    expect(api.savePreset).not.toHaveBeenCalled();
  });
  it("asks before deleting", async () => {
    const { api } = install({ ...defaultState, presets: [preset] });
    render(<App />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Remove My preset" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.removePreset).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.removePreset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove My preset" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete preset",
      }),
    );
    await waitFor(() =>
      expect(api.removePreset).toHaveBeenCalledWith({ id: preset.id }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "My preset" })).toBeNull(),
    );
  });
});
