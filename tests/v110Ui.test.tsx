// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "../src/App";
import { outcomeOf } from "../src/views/optimizations/ResultStep";
import { LaunchSettings } from "../src/views/gamemode/LaunchSettings";
import {
  GameSchema,
  defaultState,
  type Activity,
  type Bootstrap,
  type FrameforgeApi,
  type OperationId,
} from "../shared/contracts";

const row = (
  id: string,
  ids: OperationId[],
  status: Activity["status"] = "success",
): Activity => ({
  id,
  label: "Optimization applied",
  at: "2026-10-14T01:00:00.000Z",
  status,
  message: "x",
  ids,
  rollback: true,
});
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const bootstrap = (activity: Activity[]): Bootstrap =>
  ({
    state: defaultState,
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
    activity,
    backups: [],
    capabilities: ["uac-off"],
    bootedAt: "2026-10-14T00:00:00.000Z",
    drifted: [],
    startupSupported: false,
    version: "test",
    mode: "desktop",
    boost: { session: null, available: true, watching: false },
    scan: { running: false, lastScanAt: null },
  }) as unknown as Bootstrap;

function install(
  activity: Activity[],
  rollback: (id: string) => Promise<Activity>,
) {
  const calls: string[] = [];
  window.frameforge = {
    bootstrap: async () => bootstrap(activity),
    onEvent: () => () => undefined,
    restoreStatus: async () => {
      throw new Error("not needed");
    },
    rollback: async (input: { id: string }) => {
      calls.push(input.id);
      return rollback(input.id);
    },
  } as unknown as FrameforgeApi;
  return calls;
}
beforeEach(() => {
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});

describe("I-2: Dashboard security banner and Restore all", () => {
  it("counts a security item in recovery-needed as still lowered", async () => {
    install([row(A, ["uac-off"], "recovery-needed")], async () =>
      row(A, ["uac-off"], "rolled-back"),
    );
    render(<App />);
    expect(
      await screen.findByText("Security settings are lowered on this PC."),
    ).toBeVisible();
  });
  it("stops at the first item that is not restored and names what remains lowered", async () => {
    const calls = install(
      [
        row(A, ["uac-off"]),
        row(B, ["smartscreen-off"], "recovery-needed"),
        row(C, ["defender-off"]),
      ],
      async (id) => ({
        ...row(id, ["uac-off"], "recovery-needed"),
        rollback: true,
      }),
    );
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Restore all security settings",
      }),
    );
    await screen.findByText(/Stopped\. Still lowered: Turn off User Account/);
    expect(calls).toEqual([A]);
    expect(screen.getByText(/Still lowered:/)).toHaveTextContent(
      /SmartScreen.*Defender|Defender.*SmartScreen/,
    );
    expect(
      screen.getByText("Security settings are lowered on this PC."),
    ).toBeVisible();
  });
  it("also stops when the rollback is refused (declined or blocked)", async () => {
    const calls = install(
      [row(A, ["uac-off"]), row(B, ["smartscreen-off"])],
      () => Promise.reject(new Error("Rollback not done - declined.")),
    );
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Restore all security settings",
      }),
    );
    await screen.findByText(/Stopped\. Still lowered:/);
    expect(calls).toEqual([A]);
  });
});

describe("apply results", () => {
  const base = row(A, ["capture-off"]);
  it("labels Already set, Not applied and a plain success", () => {
    expect(
      outcomeOf({ ...base, message: "Already set \u2014 no change. x" }, 0)
        .label,
    ).toBe("Already set \u2014 no change");
    expect(
      outcomeOf(
        {
          ...base,
          status: "cancelled",
          message: "Not applied \u2014 administrator approval declined.",
        },
        0,
      ).label,
    ).toBe("Not applied");
    expect(
      outcomeOf({ ...base, message: "Windows settings re-read" }, 0).label,
    ).toBe("Applied");
  });
});

describe("QA3: launch settings without a known .exe", () => {
  it("says what to do instead of Unsupported, with the existing chooser", async () => {
    const game = GameSchema.parse({
      id: A,
      name: "Scanned Game",
      path: "C:/Games/Scanned",
      source: "steam",
      profile: "gaming",
      notes: "",
    });
    window.frameforge = {
      onEvent: () => () => undefined,
      launchSettings: async () => ({
        gameId: A,
        executable: null,
        settings: ["gpuPreference", "fullscreenOptimizations"].map(
          (setting) => ({
            setting,
            state: "unsupported",
            detail: "Frameforge does not know this game's executable.",
            current: null,
            canRevert: false,
            appliedAt: null,
          }),
        ),
      }),
    } as unknown as FrameforgeApi;
    const data = {
      ...bootstrap([]),
      state: { ...defaultState, games: [game] },
    };
    render(
      <LaunchSettings
        data={data}
        game={game}
        gameId={A}
        run={async () => undefined}
        pending={false}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getAllByText("Choose the game's .exe to enable"),
      ).toHaveLength(2),
    );
    expect(screen.queryByText("unsupported")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: /Choose the game's \.exe/ }).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
