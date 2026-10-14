// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "../src/App";
import {
  defaultState,
  type AppEvent,
  type FrameforgeApi,
} from "../shared/contracts";
beforeEach(() => {
  localStorage.clear();
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});
describe("configuration and safety UI", () => {
  it("labels demo data and disables Windows confirmation", async () => {
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    expect(screen.getByText("Demo data")).toBeVisible();
    fireEvent.click(screen.getByText("Consistent pointer movement"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "Confirm & apply" }),
    ).toBeDisabled();
  });
  it("creates a named configuration backup through the accessible dialog", async () => {
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Restore & backups" }));
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Backup name"), {
      target: { value: "My configuration" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create backup" }),
    );
    expect(await screen.findByText("My configuration")).toBeVisible();
  });
  it("separates Windows System Restore from app backups and disables demo creation", async () => {
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Restore & backups" }));
    expect(
      screen.getByRole("heading", {
        name: "Windows System Restore (whole-PC recovery)",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "App configuration backups" }),
    ).toBeVisible();
    const create = screen.getByRole("button", { name: "Create restore point" });
    expect(create).toBeDisabled();
    expect(create).toHaveAccessibleDescription(
      "Windows System Restore requires the desktop app.",
    );
  });
  it("shows scan progress, then a per-source table with not-installed and failed sources", async () => {
    const bootstrap = {
      state: {
        ...defaultState,
        games: [
          {
            id: crypto.randomUUID(),
            name: "The Outlast Trials",
            path: "C:/Steam/Outlast",
            source: "steam" as const,
            executablePath: null,
            profile: "balanced" as const,
            boostMode: "global" as const,
            notes: "",
          },
        ],
      },
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
      boost: { session: null, available: false, watching: false },
    };
    const listeners = new Set<(event: AppEvent) => void>();
    const emit = (event: AppEvent) => listeners.forEach((l) => l(event));
    let finish: () => void = () => {};
    window.frameforge = {
      bootstrap: async () => bootstrap,
      onEvent: (callback: (event: AppEvent) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      detectGames: () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              games: [],
              warnings: ["Microsoft Store titles are limited."],
              launchers: ["Steam"],
              perLauncher: [
                { launcher: "Steam", found: 3, skipped: 1, status: "scanned" },
                {
                  launcher: "GOG",
                  found: 0,
                  skipped: 0,
                  status: "not-installed",
                },
                { launcher: "EA app", found: 0, skipped: 0, status: "error" },
                {
                  launcher: "Riot Games",
                  found: 0,
                  skipped: 0,
                  status: "scanned",
                },
              ],
            });
        }),
    } as unknown as FrameforgeApi;
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Game library" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rescan" }));
    expect(await screen.findByText(/Scanning your PC/)).toBeVisible();
    act(() =>
      emit({
        type: "scan-progress",
        launcher: "Riot Games",
        done: 8,
        total: 11,
        found: 5,
      }),
    );
    expect(
      await screen.findByText(
        "Scanned Riot Games (8/11). 5 games found so far.",
      ),
    ).toBeVisible();
    act(() => finish());
    const steam = (await screen.findByRole("cell", { name: "Steam" })).closest(
      "tr",
    )!;
    expect(within(steam).getByText("Scanned")).toBeVisible();
    expect(
      within(
        screen.getByRole("cell", { name: "GOG" }).closest("tr")!,
      ).getByText("Not installed"),
    ).toBeVisible();
    expect(
      within(
        screen.getByRole("cell", { name: "EA app" }).closest("tr")!,
      ).getByText("Failed"),
    ).toBeVisible();
    expect(
      within(
        screen.getByRole("cell", { name: "Riot Games" }).closest("tr")!,
      ).getByText("Installed, no games found"),
    ).toBeVisible();
    expect(
      screen.getByText("Microsoft Store titles are limited."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Game details/ }));
    expect(await screen.findByText("Matched by folder")).toBeVisible();
  });
  it("shows booster modes in demo mode with Start disabled and explained", async () => {
    localStorage.setItem(
      "frameforge-demo-v1",
      JSON.stringify({
        state: {
          ...defaultState,
          games: [
            {
              id: crypto.randomUUID(),
              name: "Demo game",
              path: "C:\\Games\\Demo",
              source: "custom",
              executablePath: null,
              profile: "balanced",
              boostMode: "global",
              notes: "",
            },
          ],
        },
        backups: [],
        activity: [],
      }),
    );
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Game Mode" }));
    const modes = await screen.findByRole("group", { name: "Boost mode" });
    for (const name of [
      "Off",
      "Balanced",
      "Performance",
      "Competitive",
      "Custom",
    ])
      expect(within(modes).getByRole("button", { name })).toBeVisible();
    const start = screen.getByRole("button", { name: "Start boost" });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute(
      "title",
      "Game booster requires the desktop app.",
    );
    fireEvent.click(within(modes).getByRole("button", { name: "Performance" }));
    // Each mode card says what it would do on this PC; background apps are not configured yet.
    const card = await screen.findByRole("article", {
      name: "Performance on this PC",
    });
    card.querySelectorAll("details").forEach((d) => (d.open = true));
    expect(within(card).getByText("Performance power plan")).toBeVisible();
    expect(within(card).getByText("not configured")).toBeVisible();
    expect(screen.getByText("Standby list purge")).toBeInTheDocument();
  });
});
