// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import App from "../src/App";
import {
  defaultState,
  type AppEvent,
  type AppState,
  type FrameforgeApi,
} from "../shared/contracts";

function install(settings: Partial<AppState["settings"]>, analytics = true) {
  const listeners = new Set<(event: AppEvent) => void>();
  const calls: { method: string; input: unknown }[] = [];
  let state: AppState = {
    ...defaultState,
    settings: { ...defaultState.settings, ...settings },
  };
  const bootstrap = () => ({
    state,
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
    capabilities: [],
    startupSupported: false,
    version: "test",
    mode: "desktop",
    boost: { session: null, available: true, watching: false },
  });
  const update = () => ({
    state: "idle",
    current: "test",
    version: null,
    notes: "",
    percent: 0,
    error: "",
    installOnQuit: false,
    analyticsAvailable: analytics,
  });
  const note =
    (method: string, fn?: (input: never) => unknown) =>
    async (input: never) => {
      calls.push({ method, input });
      return fn ? fn(input) : true;
    };
  window.frameforge = {
    bootstrap: async () => structuredClone(bootstrap()),
    onEvent: (callback: (event: AppEvent) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    updateStatus: async () => update(),
    settings: note("settings", (input: AppState["settings"]) => {
      state = { ...state, settings: input };
      return state;
    }),
    updateCheck: note("updateCheck", update),
    closeAnswer: note("closeAnswer"),
    trackUsage: async () => true,
  } as unknown as FrameforgeApi;
  return {
    calls,
    emit: (event: AppEvent) => act(() => listeners.forEach((l) => l(event))),
    saved: () =>
      calls.find((c) => c.method === "settings")?.input as
        AppState["settings"] | undefined,
  };
}
beforeEach(() => {
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});
const next = () =>
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
const toggle = (name: string) => screen.findByRole("switch", { name });
const updates = "Check for updates automatically";
const stats = "Share anonymous usage statistics";
const tray = "Keep Frameforge in the tray when I close the window";

describe("first-run welcome", () => {
  it("walks three steps with the documented defaults and saves them", async () => {
    const api = install({});
    render(<App />);
    const title = await screen.findByRole("heading", {
      name: "Welcome to Frameforge",
    });
    expect(title).toHaveFocus();
    next();
    const heading = await screen.findByRole("heading", {
      name: "Privacy and updates",
    });
    expect(heading).toHaveFocus();
    expect(await toggle(updates)).toBeChecked();
    expect(await toggle(stats)).not.toBeChecked();
    expect(screen.getByText(/What.s shared/)).toBeInTheDocument();
    next();
    expect(await toggle(tray)).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByText("Your setup, in focus.");
    expect(api.saved()).toMatchObject({
      privacyAsked: true,
      updateCheck: true,
      analytics: false,
      keepRunning: true,
    });
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "updateCheck")).toBe(true),
    );
  });
  it("saves the user's changes and keeps them when going back a step", async () => {
    const api = install({});
    render(<App />);
    await screen.findByRole("heading", { name: "Welcome to Frameforge" });
    next();
    fireEvent.click(await toggle(updates));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: stats })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("switch", { name: stats }));
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(await toggle(stats)).toBeChecked();
    next();
    fireEvent.click(await toggle(tray));
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    await screen.findByText("Your setup, in focus.");
    expect(api.saved()).toMatchObject({
      privacyAsked: true,
      updateCheck: false,
      analytics: true,
      keepRunning: false,
    });
    expect(api.calls.some((c) => c.method === "updateCheck")).toBe(false);
  });
  it("cannot turn statistics on in a build without a key", async () => {
    const api = install({}, false);
    render(<App />);
    await screen.findByRole("heading", { name: "Welcome to Frameforge" });
    next();
    expect(await toggle(stats)).toBeDisabled();
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Get started" }));
    await screen.findByText("Your setup, in focus.");
    expect(api.saved()?.analytics).toBe(false);
  });
  it("also appears for an upgrade that never answered, keeping its other settings", async () => {
    const api = install({ autoScanHours: 48, closeAction: "tray" });
    render(<App />);
    await screen.findByRole("heading", { name: "Welcome to Frameforge" });
    next();
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Get started" }));
    await screen.findByText("Your setup, in focus.");
    expect(api.saved()).toMatchObject({
      autoScanHours: 48,
      closeAction: "tray",
    });
  });
  it("is skipped once the privacy question has been answered", async () => {
    install({ privacyAsked: true });
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    expect(
      screen.queryByRole("heading", { name: "Welcome to Frameforge" }),
    ).toBeNull();
  });
});

describe("in-app close prompt", () => {
  const replies = (api: ReturnType<typeof install>) =>
    api.calls.filter((c) => c.method === "closeAnswer").map((c) => c.input);
  it("confirms it is shown, then answers tray with Remember my choice", async () => {
    const api = install({ privacyAsked: true });
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    api.emit({ type: "close-ask" });
    await screen.findByRole("dialog", {
      name: "Keep Frameforge running in the tray?",
    });
    expect(
      screen.getByRole("button", { name: "Minimize to tray" }),
    ).toHaveFocus();
    await waitFor(() =>
      expect(replies(api)).toEqual([{ action: "shown", remember: false }]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Minimize to tray" }));
    await waitFor(() =>
      expect(replies(api).at(-1)).toEqual({ action: "tray", remember: true }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("answers quit without remembering when the box is unticked", async () => {
    const api = install({ privacyAsked: true });
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    api.emit({ type: "close-ask" });
    fireEvent.click(await toggle("Remember my choice"));
    fireEvent.click(screen.getByRole("button", { name: "Quit Frameforge" }));
    await waitFor(() =>
      expect(replies(api).at(-1)).toEqual({ action: "quit", remember: false }),
    );
  });
  it("Esc leaves the window open", async () => {
    const api = install({ privacyAsked: true });
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    api.emit({ type: "close-ask" });
    await screen.findByRole("dialog");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(replies(api).at(-1)).toEqual({
        action: "cancel",
        remember: false,
      }),
    );
  });
});
