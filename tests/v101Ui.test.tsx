// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "../src/App";
import {
  defaultState,
  MechanismId,
  type AppEvent,
  type BoostMode,
  type BoostSession,
  type FrameforgeApi,
} from "../shared/contracts";
const mk = (name: string) => ({
  id: crypto.randomUUID(),
  name,
  path: `C:/Games/${name}`,
  source: "custom" as const,
  executablePath: `C:/Games/${name}/game.exe`,
  profile: "balanced" as const,
  boostMode: "global" as const,
  notes: "",
});
type Setting = {
  state: string;
  canRevert: boolean;
  detail?: string;
};
export function harness(
  options: {
    games?: ReturnType<typeof mk>[];
    capabilities?: string[];
    launch?: Record<string, Setting>;
    mode?: BoostMode;
  } = {},
) {
  const calls: { method: string; input: unknown }[] = [];
  const listeners: Array<(e: AppEvent) => void> = [];
  const model = {
    games: options.games ?? [mk("Alpha")],
    capabilities: options.capabilities ?? ["mouse-precision"],
    launch: options.launch ?? {
      gpuPreference: { state: "ready", canRevert: false },
      fullscreenOptimizations: { state: "ready", canRevert: false },
    },
    booster: { ...defaultState.booster, mode: options.mode ?? "balanced" },
    caps: {} as Record<
      string,
      { available: boolean; detail: string; active: boolean; code?: string }
    >,
    timer: {
      eligible: false,
      enabled: false,
      ownedByFrameforge: false,
      restartRequired: false,
    },
    session: null as BoostSession | null,
    startupSupported: false,
  };
  const bootstrap = () => ({
    state: { ...defaultState, games: model.games, booster: model.booster },
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
    capabilities: model.capabilities,
    startupSupported: model.startupSupported,
    version: "test",
    mode: "desktop",
    boost: { session: model.session, available: true, watching: false },
  });
  const answers: Record<string, (input: never) => unknown> = {
    bootstrap: () => bootstrap(),
    launchSettings: (input: { gameId: string }) => ({
      gameId: input.gameId,
      executable: "C:\\Games\\game.exe",
      settings: Object.entries(model.launch).map(([setting, s]) => ({
        setting,
        state: s.state,
        detail: s.detail ?? "Detail.",
        current: null,
        canRevert: s.canRevert,
        appliedAt: s.canRevert ? "2026-10-13T10:00:00.000Z" : null,
      })),
    }),
    boostStatus: () => ({
      session: model.session,
      capabilities: {
        logicalCpus: 12,
        topology: null,
        mechanisms: MechanismId.options.map((id) => ({
          id,
          ...(model.caps[id] ?? {
            available: true,
            detail: "ok",
            active: false,
          }),
        })),
      },
      watching: false,
      ownedPowerPlan: false,
      timer: model.timer,
    }),
    boostConfig: (input: typeof defaultState.booster) => {
      model.booster = input;
      return bootstrap().state;
    },
  };
  const wrap =
    (name: string, fn: (input: never) => unknown) => async (input: never) => {
      calls.push({ method: name, input });
      return fn(input);
    };
  const install = (extra: Record<string, (input: never) => unknown> = {}) => {
    const all = { ...answers, ...extra };
    window.frameforge = {
      ...Object.fromEntries(
        Object.entries(all).map(([k, v]) => [k, wrap(k, v)]),
      ),
      onEvent: (cb: (e: AppEvent) => void) => {
        listeners.push(cb);
        return () => {};
      },
    } as unknown as FrameforgeApi;
  };
  return {
    calls,
    model,
    install,
    emit: (e: AppEvent) => act(() => listeners.forEach((l) => l(e))),
  };
}
beforeEach(() => {
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});
async function openGameMode() {
  render(<App />);
  await screen.findByText("Your setup, in focus.");
  fireEvent.click(screen.getByRole("button", { name: "Game Mode" }));
  await screen.findByRole("heading", { name: "Game Mode", level: 1 });
}
describe("I-3: a stuck launch setting can be forgotten", () => {
  it.each(["recovery-needed", "failed", "conflict"])(
    "offers Forget (with a confirmation) when the row is %s",
    async (state) => {
      const h = harness({
        launch: {
          gpuPreference: { state, canRevert: true },
          fullscreenOptimizations: { state: "ready", canRevert: false },
        },
      });
      h.install({
        launchSettingApply: () => ({
          gameId: h.model.games[0]!.id,
          executable: "C:\\Games\\game.exe",
          settings: [],
        }),
      });
      await openGameMode();
      const forget = await screen.findByRole("button", {
        name: "Forget saved value",
      });
      fireEvent.click(forget);
      // Nothing is sent until the dialog is confirmed.
      expect(h.calls.some((c) => c.method === "launchSettingApply")).toBe(
        false,
      );
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/Windows is not changed/)).toBeVisible();
      fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));
      await waitFor(() =>
        expect(
          h.calls.find((c) => c.method === "launchSettingApply")?.input,
        ).toMatchObject({ setting: "gpuPreference", action: "forget" }),
      );
    },
  );
  it("does not offer Forget for a healthy applied value", async () => {
    const h = harness({
      launch: {
        gpuPreference: { state: "applied", canRevert: true },
        fullscreenOptimizations: { state: "ready", canRevert: false },
      },
    });
    h.install();
    await openGameMode();
    await screen.findByRole("button", { name: /Revert/ });
    expect(
      screen.queryByRole("button", { name: "Forget saved value" }),
    ).toBeNull();
  });
});
describe("I-5: Game Mode follows the library", () => {
  it("selects the first game once a scan fills an empty library", async () => {
    const h = harness({ games: [] });
    h.install();
    await openGameMode();
    expect(
      (await screen.findAllByText(/Add a game first/)).length,
    ).toBeGreaterThan(0);
    h.model.games = [mk("Alpha"), mk("Beta")];
    // The scan-finished event makes the app re-read its state.
    await h.emit({ type: "scan", phase: "finished", auto: true, added: 2 });
    const select = await screen.findByRole("combobox", { name: /Game/ });
    await waitFor(() =>
      expect(
        h.calls.filter((c) => c.method === "launchSettings").length,
      ).toBeGreaterThan(0),
    );
    expect(select).toHaveValue(h.model.games[0]!.id);
    expect(
      (
        h.calls.find((c) => c.method === "launchSettings")!.input as {
          gameId: string;
        }
      ).gameId,
    ).toBe(h.model.games[0]!.id);
    expect(screen.queryByText(/Choose a game first/)).not.toBeInTheDocument();
  });
  it("falls back to the first game when the picked one is removed", async () => {
    const games = [mk("Alpha"), mk("Beta")];
    const h = harness({ games });
    h.install();
    await openGameMode();
    const select = await screen.findByRole("combobox", { name: /Game/ });
    fireEvent.change(select, { target: { value: games[1]!.id } });
    expect(select).toHaveValue(games[1]!.id);
    h.model.games = [games[0]!];
    await h.emit({ type: "scan", phase: "finished", auto: false, added: 0 });
    await waitFor(() => expect(select).toHaveValue(games[0]!.id));
  });
});

const timerRow = async () =>
  (await screen.findByText(/High timer resolution on this PC/)).closest("li")!;
const off = (detail: string) => ({ available: false, detail, active: false });
describe("timer resolution on Windows 11", () => {
  const win11Off = (h: ReturnType<typeof harness>) => {
    h.model.caps.timerResolution = off(
      "On Windows 11 a program's timer request only reaches the whole system when GlobalTimerResolutionRequests is on.",
    );
    h.model.timer = {
      eligible: true,
      enabled: false,
      ownedByFrameforge: false,
      restartRequired: false,
    };
  };
  it("offers an opt-in with a restart warning, saves nothing until confirmed, then offers Turn back off", async () => {
    const h = harness();
    win11Off(h);
    h.install({
      boostTimerGlobal: (input: { action: string }) => {
        h.model.timer =
          input.action === "enable"
            ? {
                eligible: true,
                enabled: true,
                ownedByFrameforge: true,
                restartRequired: true,
              }
            : {
                eligible: true,
                enabled: false,
                ownedByFrameforge: false,
                restartRequired: false,
              };
        return {
          session: null,
          capabilities: { logicalCpus: 12, mechanisms: [] },
          watching: false,
          ownedPowerPlan: false,
          timer: h.model.timer,
        };
      },
    });
    await openGameMode();
    const row = await timerRow();
    await within(row).findByText("off in Windows");
    fireEvent.click(
      within(row).getByRole("button", {
        name: /Allow games to keep high timer resolution…/,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/you must restart Windows/)).toBeVisible();
    expect(
      within(dialog).getByText(/GlobalTimerResolutionRequests/),
    ).toBeVisible();
    expect(h.calls.some((c) => c.method === "boostTimerGlobal")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow it" }));
    await waitFor(() =>
      expect(
        h.calls.find((c) => c.method === "boostTimerGlobal")?.input,
      ).toEqual({ action: "enable", confirmed: true }),
    );
    const after = await timerRow();
    await within(after).findByText("restart Windows to finish");
    // The offer is replaced by the way back, not left as a dead button.
    expect(
      within(after).queryByRole("button", { name: /Allow games/ }),
    ).toBeNull();
    fireEvent.click(
      within(after).getByRole("button", { name: /Turn back off…/ }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Turn back off",
      }),
    );
    await waitFor(() =>
      expect(
        h.calls.filter((c) => c.method === "boostTimerGlobal").at(-1)?.input,
      ).toEqual({ action: "restore", confirmed: true }),
    );
    await within(await timerRow()).findByText("off in Windows");
  });
  it("stays honestly unsupported on Windows 10 and does not offer a button", async () => {
    const h = harness();
    h.model.caps.timerResolution = off(
      "On Windows 10 version 2004 and later a timer request only affects the requesting process, so it cannot reach the game.",
    );
    h.model.timer = {
      eligible: false,
      enabled: false,
      ownedByFrameforge: false,
      restartRequired: false,
    };
    h.install();
    await openGameMode();
    const row = await timerRow();
    await within(row).findByText("unsupported");
    expect(
      within(row).getByText(/only affects the requesting process/),
    ).toBeVisible();
    expect(
      within(row).getByText(/nothing Frameforge can change/),
    ).toBeVisible();
    expect(within(row).queryByRole("button")).toBeNull();
  });
  it("shows an already-on setting as such, without a button", async () => {
    const h = harness();
    h.model.timer = {
      eligible: true,
      enabled: true,
      ownedByFrameforge: false,
      restartRequired: false,
    };
    h.install();
    await openGameMode();
    const row = await timerRow();
    await within(row).findByText("already on in Windows");
    expect(within(row).queryByRole("button")).toBeNull();
  });
});
describe("standby list purge", () => {
  it("is an opt-in under Custom with an honest description, not a dead 'unsupported' row", async () => {
    const h = harness({ mode: "custom" });
    h.model.caps.standbyPurge = {
      available: true,
      detail:
        "Clears Windows' cached (standby) memory once, when the boost starts.",
      active: false,
    };
    h.install();
    await openGameMode();
    const row = (await screen.findByText("Standby list purge")).closest("li")!;
    await within(row).findByText(/off \(opt-in under Custom\)/);
    expect(within(row).queryByText("unsupported")).toBeNull();
    const toggle = await screen.findByRole("switch", {
      name: /Clear the standby memory list once/,
    });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        (
          h.calls.find((c) => c.method === "boostConfig")?.input as {
            custom: { standbyPurge: boolean };
          }
        ).custom.standbyPurge,
      ).toBe(true),
    );
    // No preset lists it.
    for (const name of ["Balanced", "Performance", "Competitive"])
      expect(
        within(
          screen.getByRole("article", { name: `${name} on this PC` }),
        ).queryByText("Standby list purge"),
      ).toBeNull();
  });
});
describe("Game Bar capture blocked by policy", () => {
  it("reads 'already off by policy', not unavailable, and is not counted as a change", async () => {
    const h = harness({ mode: "balanced" });
    h.model.caps.gameBarCapture = {
      available: true,
      detail:
        "Already off by policy (AllowGameDVR=0), and the overlay hook is off; nothing to change.",
      active: true,
      code: "policy",
    };
    h.install();
    await openGameMode();
    const card = await screen.findByRole("article", {
      name: "Balanced on this PC",
    });
    await within(card).findByText("already off by policy");
    expect(within(card).queryByText("unavailable")).toBeNull();
    expect(within(card).queryByText("unsupported")).toBeNull();
    expect(within(card).getByText("Game Bar capture off")).toBeVisible();
  });
  it("labels the session result the same way", async () => {
    const h = harness({ mode: "balanced" });
    h.model.session = {
      id: crypto.randomUUID(),
      gameId: h.model.games[0]!.id,
      mode: "balanced",
      target: {
        pid: 4,
        startTime: "2026-10-12T10:00:00.0000000Z",
        executablePath: "C:/Games/Alpha/game.exe",
        name: "game",
        priority: "Normal",
      },
      startedAt: "2026-10-13T10:00:00.000Z",
      endedAt: null,
      status: "active",
      message: "Balanced mode active.",
      mechanisms: [
        {
          id: "gameBarCapture",
          state: "skipped",
          detail: "Already off by policy.",
          code: "policy",
        },
      ],
      samples: [],
      failed: false,
      abnormal: false,
    };
    h.install();
    await openGameMode();
    expect(
      await screen.findByText("Game Bar capture off: already off by policy"),
    ).toBeVisible();
  });
});
describe("a boost that waits for administrator approval", () => {
  it("shows the waiting row, keeps Stop available and shows the answer in its place", async () => {
    const h = harness({ mode: "competitive" });
    const game = h.model.games[0]!;
    const base = {
      id: crypto.randomUUID(),
      gameId: game.id,
      mode: "competitive" as const,
      target: {
        pid: 4,
        startTime: "2026-10-12T10:00:00.0000000Z",
        executablePath: "C:/Games/Alpha/game.exe",
        name: "game",
        priority: "Normal" as const,
      },
      startedAt: "2026-10-13T10:00:00.000Z",
      endedAt: null,
      status: "active" as const,
      samples: [],
      failed: false,
      abnormal: false,
    };
    const waiting: BoostSession = {
      ...base,
      message:
        "Competitive mode active for Alpha: 2 change(s) applied. Waiting for administrator approval to pause services. The boost works without it, and Stop cancels the request.",
      mechanisms: [
        {
          id: "pauseServices",
          state: "pending",
          detail: "Waiting for administrator approval to pause services.",
        },
      ],
    };
    h.model.session = waiting;
    h.install({
      boostStop: () => ({ ...waiting, status: "ended", message: "Stopped." }),
    });
    await openGameMode();
    expect(
      await screen.findByText(
        "Pause Windows services: waiting for admin approval",
      ),
    ).toBeVisible();
    const stop = await screen.findByRole("button", {
      name: /Stop and restore/,
    });
    expect(stop).toBeEnabled();
    const answered: BoostSession = {
      ...waiting,
      message: "Paused 2 service(s).",
      mechanisms: [
        {
          id: "pauseServices",
          state: "applied",
          detail: "Paused 2 service(s).",
        },
      ],
    };
    // The event is mirrored in the next status read, as the real service does.
    h.model.session = answered;
    await h.emit({ type: "boost", session: answered });
    expect(
      await screen.findByText("Pause Windows services: applied"),
    ).toBeVisible();
    expect(screen.queryByText(/waiting for admin approval/)).toBeNull();
    fireEvent.click(stop);
    await waitFor(() =>
      expect(h.calls.some((c) => c.method === "boostStop")).toBe(true),
    );
  });
});
describe("settings and system wording", () => {
  it("says launch at sign-in is available in the installed app, and gives reasons for the unmeasured readings", async () => {
    const h = harness();
    h.install();
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      await screen.findByText(/Available in the installed app\./),
    ).toBeVisible();
    expect(
      screen.getByRole("switch", { name: /Launch at sign-in/ }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(
      await screen.findByText(/needs a hardware-monitoring driver/),
    ).toBeVisible();
    expect(screen.getByText(/does not\s+measure FPS/)).toBeVisible();
    expect(screen.queryByText("Unsupported in this release")).toBeNull();
  });
  it("keeps launch at sign-in enabled in the installed (packaged) app", async () => {
    const h = harness();
    h.model.startupSupported = true;
    h.install();
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      await screen.findByRole("switch", { name: /Launch at sign-in/ }),
    ).toBeEnabled();
    expect(screen.queryByText(/Available in the installed app\./)).toBeNull();
  });
});
describe("launch settings without a known executable", () => {
  it("offers to choose the .exe and re-reads the settings afterwards", async () => {
    const h = harness({
      launch: {
        gpuPreference: {
          state: "unsupported",
          canRevert: false,
          detail: "Frameforge does not know this game's executable.",
        },
        fullscreenOptimizations: { state: "unsupported", canRevert: false },
      },
    });
    let chosen = false;
    h.install({
      launchSettings: (input: { gameId: string }) => ({
        gameId: input.gameId,
        executable: chosen ? "C:/Games/Alpha/game.exe" : null,
        settings: [],
      }),
      chooseExecutable: () => {
        chosen = true;
        return h.model.games[0];
      },
    });
    await openGameMode();
    const button = await screen.findByRole("button", {
      name: /Choose the game's .exe…/,
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        h.calls.find((c) => c.method === "chooseExecutable")?.input,
      ).toEqual({ id: h.model.games[0]!.id }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Choose the game's .exe…/ }),
      ).toBeNull(),
    );
  });
});
describe("the administrator explanation before a boost", () => {
  const startCustom = async (
    custom: Partial<typeof defaultState.booster.custom>,
  ) => {
    const h = harness({ mode: "custom" });
    h.model.booster = {
      ...h.model.booster,
      custom: { ...h.model.booster.custom, ...custom },
    };
    h.install({
      boostStart: () => {
        throw new Error("not started");
      },
    });
    await openGameMode();
    const start = await screen.findByRole("button", { name: /Start boost/ });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    return { h, dialog: await screen.findByRole("dialog") };
  };
  it("names only the standby list when only that step is on", async () => {
    const { h, dialog } = await startCustom({ standbyPurge: true });
    expect(
      within(dialog).getByText("Clear the standby memory list for this boost?"),
    ).toBeVisible();
    expect(within(dialog).queryByText(/Pause Windows services/)).toBeNull();
    expect(
      within(dialog).queryByText(/another one when the boost ends/),
    ).toBeNull();
    expect(
      within(dialog).getByText(/cannot be undone and is harmless/),
    ).toBeVisible();
    expect(h.calls.some((c) => c.method === "boostStart")).toBe(false);
  });
  it("names both steps when both are on, and only services when only services are on", async () => {
    const both = await startCustom({ standbyPurge: true, pauseServices: true });
    expect(
      within(both.dialog).getByText(
        "Pause services and clear the standby memory list for this boost?",
      ),
    ).toBeVisible();
    cleanup();
    const services = await startCustom({ pauseServices: true });
    expect(
      within(services.dialog).getByText(
        "Pause Windows services for this boost?",
      ),
    ).toBeVisible();
    expect(within(services.dialog).queryByText(/standby/)).toBeNull();
  });
});

describe("review follow-ups", () => {
  const status = (h: ReturnType<typeof harness>, extra: object) => ({
    session: null,
    capabilities: { logicalCpus: 12, mechanisms: [] },
    watching: false,
    ownedPowerPlan: false,
    timer: h.model.timer,
    ...extra,
  });
  it("offers to use an existing Frameforge plan instead of creating a second one", async () => {
    const h = harness();
    h.model.caps.powerPlan = off("High performance plan not present");
    const a = "11111111-1111-4111-8111-111111111111";
    h.install({
      boostPowerPlan: (input: { action: string }) =>
        status(h, {
          ownedPowerPlan: input.action === "adopt",
          existingPlans:
            input.action === "adopt"
              ? []
              : [
                  {
                    guid: a,
                    name: "Frameforge High performance",
                    active: false,
                  },
                ],
        }),
    });
    await openGameMode();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Create High performance plan…/,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/already exists/)).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: "Create plan" }),
    ).toBeNull();
    expect(
      h.calls.some((c) => (c.input as { action?: string }).action === "adopt"),
    ).toBe(false);
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Use existing Frameforge plan",
      }),
    );
    await waitFor(() =>
      expect(
        h.calls.find((c) => (c.input as { action?: string }).action === "adopt")
          ?.input,
      ).toEqual({ action: "adopt", guid: a, confirmed: true }),
    );
  });
  it("waits for the timer prompt in the timer row only, without locking the rest of the app", async () => {
    const h = harness();
    h.model.caps.timerResolution = off("Off.");
    h.model.timer = {
      eligible: true,
      enabled: false,
      ownedByFrameforge: false,
      restartRequired: false,
    };
    let release: () => void = () => {};
    h.install({
      boostTimerGlobal: () =>
        new Promise((resolve) => {
          release = () => resolve(status(h, {}));
        }),
    });
    await openGameMode();
    const row = await timerRow();
    fireEvent.click(
      await within(row).findByRole("button", { name: /Allow games/ }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Allow it",
      }),
    );
    await within(await timerRow()).findByText(
      /Waiting for administrator approval/,
    );
    expect(
      screen.getByRole("button", { name: "Refresh system readings" }),
    ).toBeEnabled();
    release();
    await waitFor(() =>
      expect(
        screen.queryByText(/Waiting for administrator approval/),
      ).toBeNull(),
    );
  });
});
