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
import { clearGameIcons, GameIcon } from "../src/components/GameIcon";
import {
  defaultState,
  type AppEvent,
  type FrameforgeApi,
} from "../shared/contracts";

const png = "data:image/png;base64,iVBORw0KGgo=";
const base = {
  path: "C:\\Games",
  source: "steam" as const,
  executablePath: null,
  profile: "balanced" as const,
  boostMode: "global" as const,
  notes: "",
};
const withArt = { ...base, id: crypto.randomUUID(), name: "Alpha Quest" };
const withoutArt = { ...base, id: crypto.randomUUID(), name: "beta Racer" };

function install() {
  const listeners = new Set<(event: AppEvent) => void>();
  const calls: { method: string; input: unknown }[] = [];
  const bootstrap = {
    state: { ...defaultState, games: [withArt, withoutArt] },
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
    scan: { running: false, lastScanAt: "2026-10-12T10:00:00.000Z" },
    removedGames: [
      { name: "Gamma Old", path: "C:/Games/Gamma", source: "epic" as const },
    ],
  };
  window.frameforge = {
    bootstrap: async () => structuredClone(bootstrap),
    onEvent: (callback: (event: AppEvent) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    restoreStatus: async () => {
      throw new Error("not needed");
    },
    gameIcon: async (input: { id: string }) => {
      calls.push({ method: "gameIcon", input });
      return input.id === withArt.id ? png : null;
    },
    restoreGame: async (input: { path: string }) => {
      calls.push({ method: "restoreGame", input });
      bootstrap.removedGames = [];
      return bootstrap.state;
    },
    detectGames: async () => {
      calls.push({ method: "detectGames", input: {} });
      return { games: [], warnings: [], launchers: [], perLauncher: [] };
    },
  } as unknown as FrameforgeApi;
  return {
    calls,
    send: (event: AppEvent) =>
      act(() => listeners.forEach((listener) => listener(event))),
  };
}
beforeEach(() => {
  window.scrollTo = () => {};
  clearGameIcons();
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});

describe("game icons", () => {
  it("shows the icon when there is one and the first letter when there is not", async () => {
    install();
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Game library" }));
    const alpha = (await screen.findByText("Alpha Quest")).closest("article")!;
    const beta = screen.getByText("beta Racer").closest("article")!;
    await within(alpha).findByRole("presentation", { hidden: true });
    expect(alpha.querySelector("img")).toHaveAttribute("src", png);
    expect(beta.querySelector("img")).toBeNull();
    // Placeholder: decorative first letter, upper-cased.
    expect(beta.querySelector(".game-icon.placeholder")).toHaveTextContent("B");
    expect(beta.querySelector(".game-icon.placeholder")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("asks for icons by id only, and again after a scan finishes", async () => {
    const { calls, send } = install();
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Game library" }));
    await screen.findByText("Alpha Quest");
    await act(async () => {});
    const first = calls.filter((c) => c.method === "gameIcon");
    expect(first.map((c) => (c.input as { id: string }).id).sort()).toEqual(
      [withArt.id, withoutArt.id].sort(),
    );
    send({ type: "scan", phase: "finished", auto: true, added: 0 });
    await act(async () => {});
    expect(calls.filter((c) => c.method === "gameIcon").length).toBe(4);
  });

  it("shows the game's icon in the details dialog and the Game Mode picker", async () => {
    install();
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Game Mode" }));
    const picker = (await screen.findByLabelText("Game")).closest(
      ".picker-row",
    ) as HTMLElement;
    await within(picker).findByRole("presentation", { hidden: true });
    expect(picker.querySelector("img")).toHaveAttribute("src", png);
    fireEvent.click(screen.getByRole("button", { name: "Game library" }));
    fireEvent.click(
      (await screen.findAllByRole("button", { name: /Game details/ }))[0]!,
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("presentation", { hidden: true });
    expect(dialog.querySelector("img")).toHaveAttribute("src", png);
  });
});

describe("background scan UI", () => {
  it("shows unobtrusive progress on the Dashboard and the library, then clears it", async () => {
    const { send } = install();
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    expect(screen.getByRole("button", { name: /Scan now/ })).toBeEnabled();
    send({ type: "scan", phase: "started", auto: true, added: 0 });
    send({
      type: "scan-progress",
      launcher: "Steam",
      done: 2,
      total: 9,
      found: 3,
    });
    expect(
      await screen.findByText(/Steam \(2\/9\), 3 found so far/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Scanning for games/ }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Game library" }));
    expect(await screen.findByText(/Scanned Steam \(2\/9\)/)).toBeVisible();
    send({ type: "scan", phase: "finished", auto: true, added: 1 });
    await act(async () => {});
    expect(screen.queryByText(/Scanned Steam/)).toBeNull();
  });

  it("starts a manual scan from the Dashboard quick action", async () => {
    const { calls } = install();
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: /Scan now/ }));
    await act(async () => {});
    expect(calls.some((c) => c.method === "detectGames")).toBe(true);
  });

  it("offers the startup scan toggle in Settings, on by default", async () => {
    install();
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      await screen.findByRole("switch", {
        name: /Scan for games automatically on startup/,
      }),
    ).toBeChecked();
    expect(screen.getByLabelText("Scan at most every")).toHaveValue("24");
  });
});

describe("removed games", () => {
  it("lists removed games on the Games page and restores one", async () => {
    const { calls } = install();
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Game library" }));
    const summary = await screen.findByText("Removed games (1)");
    fireEvent.click(summary);
    expect(screen.getByText("Gamma Old")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restore Gamma Old" }));
    await act(async () => {});
    expect(calls.find((c) => c.method === "restoreGame")?.input).toEqual({
      path: "C:/Games/Gamma",
    });
    expect(screen.queryByText(/Removed games \(/)).toBeNull();
  });
});

describe("GameIcon", () => {
  it("does not show the previous game's icon while the next one loads", async () => {
    install();
    let release: (value: string | null) => void = () => {};
    const first = window.frameforge!.gameIcon;
    window.frameforge!.gameIcon = (input) =>
      input.id === withoutArt.id
        ? new Promise((resolve) => (release = resolve))
        : first(input);
    const { container, rerender } = render(<GameIcon game={withArt} />);
    await act(async () => {});
    expect(container.querySelector("img")).toHaveAttribute("src", png);
    rerender(<GameIcon game={withoutArt} />);
    await act(async () => {});
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".placeholder")).toHaveTextContent("B");
    await act(async () => release(png));
    expect(container.querySelector("img")).toHaveAttribute("src", png);
  });
});
