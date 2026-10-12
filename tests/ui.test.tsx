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
      boost: { session: null, available: false },
    };
    let emit: (event: AppEvent) => void = () => {};
    let finish: () => void = () => {};
    window.frameforge = {
      bootstrap: async () => bootstrap,
      onEvent: (callback: (event: AppEvent) => void) => {
        emit = callback;
        return () => {};
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
});
