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
  type BoostSession,
  type FrameforgeApi,
  type OperationId,
} from "../shared/contracts";
const game = {
  id: crypto.randomUUID(),
  name: "Test Game",
  path: "C:/Games/Test",
  source: "custom" as const,
  executablePath: null,
  profile: "balanced" as const,
  boostMode: "global" as const,
  notes: "",
};
const session = (status: BoostSession["status"]): BoostSession => ({
  id: crypto.randomUUID(),
  gameId: game.id,
  mode: "performance",
  target: {
    pid: 4,
    startTime: "2026-10-12T10:00:00.0000000Z",
    executablePath: "C:/Games/Test/game.exe",
    name: "game",
    priority: "Normal",
  },
  startedAt: "2026-10-13T10:00:00.000Z",
  endedAt: null,
  status,
  message: `Session ${status}.`,
  mechanisms: [],
  samples: [],
  failed: false,
  abnormal: false,
});
function install(capabilities: OperationId[]) {
  const listeners = new Set<(event: AppEvent) => void>();
  const calls: { method: string; input: unknown }[] = [];
  const bootstrap = {
    state: {
      ...defaultState,
      games: [game],
      booster: { ...defaultState.booster, mode: "balanced" as const },
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
    capabilities,
    startupSupported: false,
    version: "test",
    mode: "desktop",
    boost: {
      session: null as BoostSession | null,
      available: true,
      watching: false,
    },
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
    boostStatus: async () => ({
      session: bootstrap.boost.session,
      capabilities: {
        logicalCpus: 4,
        mechanisms: [
          {
            id: "powerPlan",
            available: false,
            detail: "High performance plan not present",
            active: false,
          },
        ],
      },
      watching: false,
      ownedPowerPlan: false,
    }),
    confirm: async () => ({
      id: crypto.randomUUID(),
      label: "Preset applied",
      at: "2026-10-13T10:00:00.000Z",
      status: "success" as const,
      message: "Applied and verified.",
      ids: ["mouse-precision"],
      rollback: true,
    }),
    preview: async (input: { ids: OperationId[] }) => {
      calls.push({ method: "preview", input });
      return {
        token: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        ids: input.ids,
        changes: input.ids.map((id) => ({
          id,
          setting: `setting-${id}`,
          before: "a",
          after: "b",
        })),
        warnings: [],
      };
    },
  } as unknown as FrameforgeApi;
  return {
    calls,
    // The event is mirrored in the next bootstrap, as the real service does.
    send: (s: BoostSession) => {
      bootstrap.boost.session = s.status === "ended" ? null : s;
      act(() => listeners.forEach((l) => l({ type: "boost", session: s })));
    },
  };
}
beforeEach(() => {
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});
describe("booster state across the app", () => {
  it("shows mode and session on the Dashboard and refreshes without a request", async () => {
    const { send } = install(["mouse-precision"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    expect(
      screen.getByText(/Mode Balanced; auto-boost off; no active session/),
    ).toBeVisible();
    const active = session("active");
    send(active);
    expect(
      await screen.findByText("Test Game: Performance mode, active"),
    ).toBeVisible();
    // The Dashboard card links to Game Mode.
    fireEvent.click(
      screen.getByRole("button", {
        name: /Game Mode.*Idle|Game Mode.*Test Game/,
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Boost session" }),
    ).toBeVisible();
  });
  it("re-enables Remove in the library when the session ends", async () => {
    const { send } = install(["mouse-precision"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Game library" }));
    const remove = await screen.findByRole("button", {
      name: "Remove Test Game",
    });
    expect(remove).toBeEnabled();
    const active = session("active");
    send(active);
    await screen.findByTitle(/Stop Game Mode for this game/);
    expect(remove).toBeDisabled();
    send({ ...active, status: "ended" });
    await act(async () => {});
    expect(
      screen.getByRole("button", { name: "Remove Test Game" }),
    ).toBeEnabled();
  });
  it("counts a recovery-needed session in the banner and sends the user to Game Mode", async () => {
    const { send } = install(["mouse-precision"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    send(session("recovery-needed"));
    const banner = await screen.findByRole("button", {
      name: /1 operation need recovery/,
    });
    expect(banner).toHaveTextContent("Open Game Mode to retry or dismiss.");
    fireEvent.click(banner);
    expect(
      await screen.findByRole("button", { name: /Retry recovery/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeVisible();
  });
});
describe("presets without a performance power plan", () => {
  it("applies the rest of the preset, marks the power plan skipped and links to Game Mode", async () => {
    const { calls } = install(["mouse-precision"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Presets" }));
    const recommended = (
      await screen.findByRole("heading", {
        name: "Recommended",
      })
    ).closest("article")!;
    expect(
      within(recommended).getByText(/Skipped — not available on this PC/),
    ).toBeVisible();
    const review = within(recommended).getByRole("button", {
      name: /Review preset/,
    });
    expect(review).toBeEnabled();
    fireEvent.click(review);
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("setting-mouse-precision"),
    ).toBeVisible();
    expect(calls.at(-1)?.input).toEqual({ ids: ["mouse-precision"] });
    expect(
      within(dialog).getAllByText(/Skipped — not available on this PC/).length,
    ).toBeGreaterThan(0);
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Create a High performance plan in Game Mode",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Game Mode", level: 1 }),
    ).toBeVisible();
    // The link must land where the fix is: the Create button is offered when the plan is missing.
    expect(
      await screen.findByRole("button", {
        name: /Create High performance plan…/,
      }),
    ).toBeEnabled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("still lists the skipped item in the operation result", async () => {
    install(["mouse-precision"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Presets" }));
    await screen.findByRole("heading", { name: "Recommended" });
    fireEvent.click(
      within(
        (await screen.findByRole("heading", { name: "Gaming" })).closest(
          "article",
        )!,
      ).getByRole("button", { name: /Review preset/ }),
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("setting-mouse-precision");
    for (const box of within(dialog).getAllByRole("checkbox"))
      fireEvent.click(box);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Confirm & apply" }),
    );
    expect(
      await within(dialog).findByText("Applied and verified."),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        /Skipped — not available on this PC: .*power plan/i,
      ),
    ).toBeVisible();
  });
});
