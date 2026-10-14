// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  act,
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
const game2 = { ...game, id: crypto.randomUUID(), name: "Second Game" };
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
      games: [game, game2],
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
    // Creating the plan makes the power-plan optimization available, as the real service's probe does.
    boostPowerPlan: async (input: { action: string }) => {
      // Looking for an existing plan is read-only and not a change the user consented to.
      if (input.action === "list")
        return {
          session: null,
          capabilities: { logicalCpus: 4, mechanisms: [] },
          watching: false,
          ownedPowerPlan: false,
          existingPlans: [],
        };
      calls.push({ method: "boostPowerPlan", input });
      bootstrap.capabilities = [...bootstrap.capabilities, "power-plan"];
      return {
        session: null,
        capabilities: { logicalCpus: 4, mechanisms: [] },
        watching: false,
        ownedPowerPlan: true,
      };
    },
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
    // The tray changed saved state while the window was open: the main process only sends {type: "state"}.
    trayToggledAutoBoost: (autoBoost: boolean) => {
      bootstrap.state = {
        ...bootstrap.state,
        booster: { ...bootstrap.state.booster, autoBoost },
      };
      act(() => listeners.forEach((l) => l({ type: "state" })));
    },
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
  it("reloads saved state when the tray changes it", async () => {
    const { trayToggledAutoBoost } = install(["mouse-precision"]);
    render(<App />);
    expect(
      await screen.findByText(/auto-boost off; no active session/),
    ).toBeVisible();
    trayToggledAutoBoost(true);
    expect(
      await screen.findByText(/auto-boost on; no active session/),
    ).toBeVisible();
  });
  it("shows mode and session on the Dashboard and refreshes without a request", async () => {
    const { send } = install(["mouse-precision"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    expect(
      await screen.findByText(
        /Mode Balanced; auto-boost off; no active session/,
      ),
    ).toBeVisible();
    const active = session("active");
    send(active);
    expect(
      await screen.findByText("Test Game: Performance mode, active"),
    ).toBeVisible();
    // The Dashboard card links to Game Mode.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Game Mode.*Idle|Game Mode.*Test Game/,
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Boost session" }),
    ).toBeVisible();
  });
  it("keeps the picked game in Game Mode across a session and a page visit", async () => {
    const { send } = install(["mouse-precision"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Game Mode" }));
    const pick = await screen.findByRole("combobox", { name: "Game" });
    fireEvent.change(pick, { target: { value: game2.id } });
    expect(pick).toHaveValue(game2.id);
    const active = { ...session("active"), gameId: game2.id };
    send(active);
    send({ ...active, status: "ended" });
    await act(async () => {});
    expect(screen.getByRole("combobox", { name: "Game" })).toHaveValue(
      game2.id,
    );
    fireEvent.click(screen.getByRole("button", { name: "Game library" }));
    fireEvent.click(await screen.findByRole("button", { name: "Game Mode" }));
    expect(await screen.findByRole("combobox", { name: "Game" })).toHaveValue(
      game2.id,
    );
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
  it("applies the rest of the preset, marks the power plan skipped and creates the plan in place", async () => {
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
    // The fix is offered right here, with consent, and nothing is created before the user agrees.
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /Create High performance plan…/,
      }),
    );
    const consent = await screen.findByRole("dialog", {
      name: /Create a High performance power plan/,
    });
    expect(calls.some((c) => c.method === "boostPowerPlan")).toBe(false);
    fireEvent.click(
      within(consent).getByRole("button", { name: "Create plan" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.method === "boostPowerPlan")?.input).toEqual({
        action: "create",
        confirmed: true,
      }),
    );
    // The preview is rebuilt with the plan: no restart, no skipped item.
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: "preview",
        input: { ids: ["mouse-precision", "power-plan"] },
      }),
    );
    const rebuilt = await screen.findByRole("dialog", {
      name: /Review preset/,
    });
    await within(rebuilt).findByText("setting-power-plan");
    // Other preset items this fake PC lacks stay skipped; the power plan is no longer one of them.
    expect(
      within(rebuilt).queryByRole("button", {
        name: /Create High performance plan…/,
      }),
    ).toBeNull();
    // Still on the same page: nothing navigated away.
    expect(
      screen.queryByRole("heading", { name: "Game Mode", level: 1 }),
    ).toBeNull();
  });
  it("offers the same one-click fix on Optimizations and Presets", async () => {
    const { calls } = install(["mouse-precision"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Optimizations" }));
    const card = (
      await screen.findByRole("heading", {
        name: "High performance power plan",
      })
    ).closest("article")!;
    expect(within(card).getByText("Not available on this PC")).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: /Create plan…/ }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: /Create a High performance/,
        }),
      ).getByRole("button", { name: "Create plan" }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.method === "boostPowerPlan")).toBe(true),
    );
    // Capabilities refresh: the card now says Available and the offer is gone, without a restart.
    await waitFor(() =>
      expect(within(card).getByText("Available")).toBeVisible(),
    );
    expect(
      within(card).queryByRole("button", { name: /Create plan…/ }),
    ).toBeNull();
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
