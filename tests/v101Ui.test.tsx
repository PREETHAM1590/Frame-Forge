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
  };
  const bootstrap = () => ({
    state: { ...defaultState, games: model.games },
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
    startupSupported: false,
    version: "test",
    mode: "desktop",
    boost: { session: null, available: true, watching: false },
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
      session: null,
      capabilities: {
        logicalCpus: 12,
        topology: null,
        mechanisms: MechanismId.options.map((id) => ({
          id,
          available: true,
          detail: "ok",
          active: false,
        })),
      },
      watching: false,
      ownedPowerPlan: false,
    }),
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
