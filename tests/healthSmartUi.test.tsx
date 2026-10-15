// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { HealthCheck } from "../src/views/HealthCheck";
import { HealthCard } from "../src/views/dashboard/HealthCard";
import { BackgroundApps } from "../src/views/gamemode/BackgroundApps";
import { SmartOffer, SmartPanel } from "../src/views/gamemode/SmartPanel";
import { ModeSelector } from "../src/views/gamemode/ModeSelector";
import { SessionPanel } from "../src/views/gamemode/SessionPanel";
import { clearHealth } from "../src/useHealth";
import { evaluateHealth } from "../shared/health";
import {
  defaultState,
  type AppEvent,
  type BoostSession,
  type FrameforgeApi,
  type Game,
  type HealthFacts,
  type RunningProcess,
  type SmartProfile,
  type SmartStatus,
} from "../shared/contracts";
import { effectiveMechanisms } from "../shared/contracts";
import type { ViewProps } from "../src/types";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const game: Game = {
  id: crypto.randomUUID(),
  name: "VALORANT",
  path: "C:/Riot/VALORANT",
  source: "riot",
  executablePath: "C:/Riot/VALORANT/VALORANT-Win64-Shipping.exe",
  profile: "balanced",
  boostMode: "smart",
  notes: "",
};
// This PC's real findings, as the helper reported them.
const facts = (): HealthFacts => ({
  battery: { present: true, onAc: true, saver: false, percent: 100 },
  powerMode: {
    overlay: "balanced",
    planGuid: "x",
    planName: "Frameforge High performance",
  },
  gpus: [
    {
      name: "NVIDIA GeForce RTX 4050 Laptop GPU",
      vendor: "nvidia",
      driverVersion: "32.0.16.1714",
      driverDate: "2026-09-17",
      integrated: false,
    },
    {
      name: "Intel(R) UHD Graphics",
      vendor: "intel",
      driverVersion: "32.0.101.6874",
      driverDate: "2025-05-25",
      integrated: true,
    },
  ],
  gpuPreferences: [
    { gameId: game.id, exe: "VALORANT-Win64-Shipping.exe", preference: null },
  ],
  nvidia: {
    name: "RTX 4050",
    driverVersion: "617.14",
    temperatureC: 59,
    clockMHz: 2610,
    maxClockMHz: 3105,
    powerDrawW: 20,
    powerLimitW: null,
    pState: "P3",
    throttleReasons: ["power cap", "thermal slowdown"],
  },
  display: { width: 1920, height: 1080, currentHz: 240, maxHz: 240 },
  memory: {
    totalBytes: 16 * GB,
    availableBytes: (1.2 * GB) | 0,
    usedPercent: 92,
    sticks: [
      {
        capacityBytes: 16 * GB,
        speedMTs: 5600,
        configuredMTs: 5200,
        bank: "BANK 0",
        slot: "DIMM0",
      },
    ],
    slots: 2,
  },
  cpuName: "13th Gen Intel(R) Core(TM) i5-13420H",
  cpuPerformancePercent: 87,
  drives: [
    {
      name: "C:",
      totalBytes: 510 * GB,
      freeBytes: (25 * GB) | 0,
      system: true,
      mediaType: "ssd",
    },
  ],
  gameMode: true,
  hags: 2,
  vbs: true,
  hvci: true,
  pendingReboot: [],
  startupApps: 4,
  overlays: ["NVIDIA Overlay", "steamwebhelper"],
  vendorApp: null,
  topRam: [
    {
      name: "brave",
      count: 21,
      cpuPercent: 2.2,
      workingSetBytes: (1.8 * GB) | 0,
    },
  ],
  topCpu: [],
});
const report = () =>
  evaluateHealth(facts(), {
    games: [
      { id: game.id, name: game.name, executablePath: game.executablePath },
    ],
    hasAbPair: false,
  });
const proc = (
  image: string,
  mb: number,
  cpu = 0,
  protectedFlag = false,
): RunningProcess => ({
  image,
  pid: Math.floor(Math.random() * 99999) + 1,
  protected: protectedFlag,
  workingSetBytes: mb * MB,
  cpuPercent: cpu,
});
const running = [
  ...Array.from({ length: 3 }, () => proc("brave.exe", 400, 1)),
  proc("OneDrive.exe", 120, 0.5),
  proc("Discord.exe", 400, 1),
  proc("explorer.exe", 150, 1, true),
  proc("VALORANT-Win64-Shipping.exe", 3000, 40),
];
type Answers = Partial<Record<string, (input: unknown) => unknown>>;
function install(answers: Answers = {}) {
  const listeners = new Set<(e: AppEvent) => void>();
  const calls: { method: string; input: unknown }[] = [];
  const api = new Proxy(
    {},
    {
      get(_t, method: string) {
        if (method === "onEvent")
          return (cb: (e: AppEvent) => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
          };
        return async (input: unknown) => {
          calls.push({ method, input });
          const answer = answers[method];
          if (answer) return answer(input);
          if (method === "smartStatus")
            return { observing: null, profiles: [], candidate: null };
          if (method === "appIcon") return null;
          return true;
        };
      },
    },
  );
  (window as unknown as { frameforge: FrameforgeApi }).frameforge =
    api as FrameforgeApi;
  return {
    calls,
    emit: (e: AppEvent) => act(() => listeners.forEach((l) => l(e))),
    of: (m: string) => calls.filter((c) => c.method === m),
  };
}
const viewProps = (over: Partial<ViewProps> = {}): ViewProps =>
  ({
    data: {
      mode: "desktop",
      state: { ...defaultState, games: [game] },
      boost: { session: null, available: true, watching: false },
    },
    pending: false,
    restorePending: false,
    run: vi.fn(async () => true),
    navigate: vi.fn(),
    preview: vi.fn(),
    scan: {},
    ...over,
  }) as unknown as ViewProps;
beforeEach(() => clearHealth());
afterEach(() => {
  cleanup();
  delete (window as unknown as { frameforge?: unknown }).frameforge;
});

describe("PC Health Check page", () => {
  it("shows the score, the top issues first and each check's meaning, impact and fix", async () => {
    install({ healthCheck: () => report() });
    render(<HealthCheck {...viewProps()} />);
    await screen.findByLabelText("Health score");
    expect(screen.getByText("Look at these first")).toBeInTheDocument();
    const channels = screen.getByRole("article", { name: "Memory channels" });
    expect(within(channels).getByText("Fix")).toBeInTheDocument();
    expect(channels).toHaveTextContent("1 module in 2 slots: single channel");
    expect(channels).toHaveTextContent("Estimate from independent testing");
    const routing = screen.getByRole("article", { name: "Game graphics card" });
    expect(routing).toHaveTextContent("VALORANT");
    expect(
      within(routing).getByRole("button", {
        name: /Set VALORANT to High performance/,
      }),
    ).toBeEnabled();
    // Inform-only items stay inform-only, with a link and no tweak button.
    const vbs = screen.getByRole("article", { name: "Memory Integrity / VBS" });
    expect(vbs).toHaveTextContent(/trade-off/);
    expect(
      within(vbs).getByRole("button", { name: /Open Core isolation/ }),
    ).toBeInTheDocument();
    // The checks nobody can read are honest about it.
    expect(
      screen.getByRole("article", { name: "HDR and variable refresh rate" }),
    ).toHaveTextContent("Can't tell");
  });

  it("opens Windows settings, the reviewed apply flow and Game Mode through the existing paths", async () => {
    const api = install({ healthCheck: () => report() });
    const props = viewProps();
    render(<HealthCheck {...props} />);
    await screen.findByLabelText("Health score");
    fireEvent.click(
      screen.getByRole("button", { name: /Open Core isolation/ }),
    );
    expect(props.run).toHaveBeenCalledWith("openSettings", {
      page: "coreIsolation",
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Choose apps to close while gaming/ }),
    );
    expect(props.navigate).toHaveBeenCalledWith("Game Mode");
    expect(api.of("healthCheck")).toHaveLength(1);
  });

  it("sets the GPU preference only after a preview and a confirmation", async () => {
    const api = install({
      healthCheck: () => report(),
      launchSettingPreview: () => ({
        setting: "gpuPreference",
        action: "apply",
        exe: "C:/Riot/VALORANT/VALORANT-Win64-Shipping.exe",
        before: null,
        after: "GpuPreference=2;",
        warning: "Windows reads this the next time the game starts.",
      }),
    });
    const props = viewProps();
    render(<HealthCheck {...props} />);
    await screen.findByLabelText("Health score");
    fireEvent.click(
      screen.getByRole("button", { name: /Set VALORANT to High performance/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("GpuPreference=2;");
    expect(dialog).toHaveTextContent("no entry: Windows decides");
    expect(props.run).not.toHaveBeenCalledWith(
      "launchSettingApply",
      expect.anything(),
      expect.anything(),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Set to High performance" }),
    );
    await waitFor(() =>
      expect(props.run).toHaveBeenCalledWith(
        "launchSettingApply",
        {
          gameId: game.id,
          setting: "gpuPreference",
          action: "apply",
          confirmed: true,
        },
        expect.stringContaining("Revert"),
      ),
    );
    expect(api.of("launchSettingPreview")).toHaveLength(1);
  });

  it("filters to what needs attention and says when the desktop app is needed", async () => {
    install({ healthCheck: () => report() });
    render(<HealthCheck {...viewProps()} />);
    await screen.findByLabelText("Health score");
    fireEvent.click(screen.getByLabelText("Needs attention"));
    expect(
      screen.queryByRole("article", { name: "Windows Game Mode" }),
    ).toBeNull();
    expect(
      screen.getByRole("article", { name: "Memory channels" }),
    ).toBeInTheDocument();
    cleanup();
    install();
    render(
      <HealthCheck
        {...viewProps({
          data: {
            mode: "demo",
            state: defaultState,
            boost: { session: null, available: false, watching: false },
          } as never,
        })}
      />,
    );
    expect(screen.getByText(/needs the desktop app/)).toBeInTheDocument();
  });

  it("shows an error from the check instead of a blank page", async () => {
    install({
      healthCheck: () => {
        throw new Error("The PC Health Check needs the Windows helper.");
      },
    });
    render(<HealthCheck {...viewProps()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "needs the Windows helper",
    );
  });
});

describe("Dashboard health card", () => {
  it("shows the score and the top three issues", async () => {
    install({ healthCheck: () => report() });
    const navigate = vi.fn();
    render(<HealthCard desktop navigate={navigate} />);
    const list = await screen.findByRole("list", { name: "Top issues" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(
      screen.getByLabelText(/Health score \d+ of 100/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Open the Health Check/ }),
    );
    expect(navigate).toHaveBeenCalledWith("Health Check");
  });
  it("does not read the PC in the browser demo", () => {
    const api = install();
    render(<HealthCard desktop={false} navigate={() => {}} />);
    expect(screen.getByText(/needs the desktop app/)).toBeInTheDocument();
    expect(api.of("healthCheck")).toHaveLength(0);
  });
});

describe("Close or pause apps while gaming", () => {
  const baseProps = () => {
    const save = vi.fn(async () => true);
    const saveGame = vi.fn(async () => true);
    return {
      save,
      saveGame,
      props: {
        config: { ...defaultState.booster, mode: "smart" as const },
        game,
        save,
        saveGame,
        pending: false,
        unavailable: "",
        desktop: true,
      },
    };
  };
  it("lists apps grouped, pre-ticks the suggested ones and keeps Discord, system and the game out", async () => {
    install({ runningProcesses: () => running });
    const { props } = baseProps();
    render(<BackgroundApps {...props} />);
    const list = await screen.findByRole("list", { name: "Running apps" });
    const brave = within(list)
      .getByText(/brave \(3\)/)
      .closest("li")!;
    expect(brave).toHaveTextContent("SUGGESTED");
    expect(within(brave).getByRole("checkbox")).toBeChecked();
    expect(brave).toHaveTextContent(/1\.2 GB/);
    const discord = within(list).getByText("Discord").closest("li")!;
    expect(within(discord).getByRole("checkbox")).not.toBeChecked();
    expect(discord).toHaveTextContent("keeps running");
    expect(within(list).queryByText("explorer")).toBeNull();
    expect(
      within(list).getByText("VALORANT-Win64-Shipping").closest("li"),
    ).not.toHaveTextContent("SUGGESTED");
    expect(
      screen.getByText(/You have not chosen your own list yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Apps to close or pause while gaming"),
    ).toHaveTextContent(/2 apps selected/);
  });

  it("saves the whole visible choice the first time a tick changes, for all games", async () => {
    install({ runningProcesses: () => running });
    const { props, save } = baseProps();
    render(<BackgroundApps {...props} />);
    const list = await screen.findByRole("list", { name: "Running apps" });
    fireEvent.click(
      within(within(list).getByText("OneDrive").closest("li")!).getByRole(
        "checkbox",
      ),
    );
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith({
      background: [{ image: "brave.exe", action: "lower" }],
      backgroundChosen: true,
    });
  });

  it("changes the action per app and offers pause or close", async () => {
    install({ runningProcesses: () => running });
    const { props, save } = baseProps();
    render(<BackgroundApps {...props} />);
    await screen.findByRole("list", { name: "Running apps" });
    fireEvent.change(screen.getByLabelText("Action for OneDrive"), {
      target: { value: "close" },
    });
    await waitFor(() => expect(save).toHaveBeenCalled());
    const rules = (
      save.mock.calls[0] as unknown as [
        { background: { image: string; action: string }[] },
      ]
    )[0].background;
    expect(rules).toContainEqual({ image: "OneDrive.exe", action: "close" });
    expect(screen.getByLabelText("Action for OneDrive")).toHaveTextContent(
      "Pause (resume after)",
    );
  });

  it("keeps a separate list for one game and can go back to the shared one", async () => {
    install({ runningProcesses: () => running });
    const { props, saveGame, save } = baseProps();
    const { rerender } = render(<BackgroundApps {...props} />);
    await screen.findByRole("list", { name: "Running apps" });
    fireEvent.click(screen.getByLabelText("Only VALORANT"));
    fireEvent.click(
      within(screen.getByText("OneDrive").closest("li")!).getByRole("checkbox"),
    );
    await waitFor(() =>
      expect(saveGame).toHaveBeenCalledWith([
        { image: "brave.exe", action: "lower" },
      ]),
    );
    expect(save).not.toHaveBeenCalled();
    rerender(
      <BackgroundApps
        {...props}
        game={{ ...game, background: [{ image: "Code.exe", action: "close" }] }}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Use the all-games list again",
      }),
    );
    expect(saveGame).toHaveBeenLastCalledWith(null);
  });

  it("adds a program that is not running, refuses protected ones and respects an empty list the person chose", async () => {
    install({ runningProcesses: () => running });
    const { props, save } = baseProps();
    render(<BackgroundApps {...props} />);
    await screen.findByRole("list", { name: "Running apps" });
    const picker = screen.getByLabelText(
      "Choose a program to add",
    ) as HTMLInputElement;
    fireEvent.change(picker, {
      target: { files: [new File([""], "Spotify.exe")] },
    });
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenLastCalledWith({
      background: expect.arrayContaining([
        { image: "Spotify.exe", action: "lower" },
      ]),
      backgroundChosen: true,
    });
    fireEvent.change(picker, {
      target: { files: [new File([""], "EasyAntiCheat.exe")] },
    });
    expect(
      await screen.findByText(/EasyAntiCheat.exe cannot be added/),
    ).toBeInTheDocument();
    cleanup();
    install({ runningProcesses: () => running });
    render(
      <BackgroundApps
        {...props}
        config={{ ...props.config, backgroundChosen: true, background: [] }}
      />,
    );
    await screen.findByRole("list", { name: "Running apps" });
    expect(
      screen.queryByText(/You have not chosen your own list yet/),
    ).toBeNull();
    expect(
      screen.getByLabelText("Apps to close or pause while gaming"),
    ).toHaveTextContent(/No apps selected/);
  });
});

describe("Smart mode on the Game Mode page", () => {
  const profile: SmartProfile = {
    gameId: game.id,
    gameName: "VALORANT",
    fingerprint: "i5",
    classification: "cpu-bound",
    flags: ["memory-pressure", "background-load"],
    mechanisms: effectiveMechanisms({
      mode: "off",
      custom: defaultState.booster.custom,
      overrides: {},
    }),
    background: [],
    reasons: ["The CPU is the limit.", "Memory is tight: 93% used."],
    advice: ["Lower CPU-heavy options."],
    nextAction: "Close memory-hungry apps.",
    at: "2026-10-15T10:00:00.000Z",
    sessions: 3,
  };
  const status = (over: Partial<SmartStatus> = {}): SmartStatus => ({
    observing: null,
    profiles: [],
    candidate: null,
    ...over,
  });
  const panel = (smart: SmartStatus, run = vi.fn(async () => true)) => (
    <SmartPanel
      game={game}
      settings={defaultState.settings}
      smart={smart}
      setSmart={() => {}}
      run={run as never}
      pending={false}
      unavailable=""
    />
  );
  it("shows the watching progress and that nothing has changed yet", () => {
    install();
    render(
      panel(
        status({
          observing: {
            gameId: game.id,
            gameName: "VALORANT",
            elapsedSeconds: 30,
            totalSeconds: 60,
          },
        }),
      ),
    );
    expect(
      screen.getByRole("status", { name: "Smart mode is watching" }),
    ).toHaveTextContent("30 of 60 seconds");
    expect(
      screen.getByRole("status", { name: "Smart mode is watching" }),
    ).toHaveTextContent("Nothing has been changed yet");
  });
  it("shows what was learned with the reasons, advice and the next step, and can forget it", async () => {
    const api = install({ smartForget: () => status() });
    render(panel(status({ profiles: [profile] })));
    const verdict = screen.getByLabelText("Smart mode verdict");
    expect(verdict).toHaveTextContent("CPU-bound");
    expect(verdict).toHaveTextContent("Memory is tight: 93% used.");
    expect(verdict).toHaveTextContent(
      "Next best step: Close memory-hungry apps.",
    );
    expect(verdict).not.toHaveTextContent(/more FPS|\+\d+%/);
    fireEvent.click(
      screen.getByRole("button", { name: "Forget and learn again" }),
    );
    await waitFor(() => expect(api.of("smartForget")).toHaveLength(1));
  });
  it("explains the administrator step and saves the opt-in without blocking the decline path", () => {
    install();
    const run = vi.fn(async () => true);
    render(panel(status(), run));
    expect(screen.getByText(/Declining is always fine/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("switch", {
        name: /Let Smart mode ask for administrator approval/,
      }),
    );
    expect(run).toHaveBeenCalledWith(
      "settings",
      expect.objectContaining({ autoBoostAdmin: true }),
      expect.any(String),
    );
  });
  it("offers a program it found and only adds it when asked", async () => {
    const api = install({ smartCandidate: () => status() });
    const run = vi.fn(async () => status());
    const set = vi.fn();
    render(
      <SmartOffer
        smart={status({
          candidate: { name: "Hades2", path: "D:/Games/Hades2.exe" },
        })}
        setSmart={set}
        run={run as never}
        pending={false}
      />,
    );
    expect(
      screen.getByRole("status", { name: "Game found" }),
    ).toHaveTextContent("Hades2");
    fireEvent.click(screen.getByRole("button", { name: "Not a game" }));
    await waitFor(() =>
      expect(api.of("smartCandidate")).toEqual([
        { method: "smartCandidate", input: { action: "dismiss" } },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to library" }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith("smartCandidate", { action: "add" }),
    );
  });
  it("renders nothing when there is no offer", () => {
    install();
    const { container } = render(
      <SmartOffer
        smart={status()}
        setSmart={() => {}}
        run={vi.fn() as never}
        pending={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
  it("lists Smart as a mode and leaves the intensity slider for the preset modes", () => {
    install();
    render(
      <ModeSelector
        mode="smart"
        pending={false}
        caps={undefined}
        mechanisms={effectiveMechanisms(defaultState.booster)}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Smart" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("slider")).toBeDisabled();
  });
  it("puts the verdict and 'This session changed' on the live session", () => {
    install();
    const session: BoostSession = {
      id: crypto.randomUUID(),
      gameId: game.id,
      mode: "smart",
      target: {
        pid: 1,
        startTime: "t",
        executablePath: "C:/g.exe",
        name: "g",
        priority: "Normal",
      },
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active",
      message: "Smart mode active.",
      mechanisms: [
        { id: "priority", state: "applied", detail: "High verified." },
      ],
      samples: [],
      failed: false,
      abnormal: false,
      smart: {
        classification: "cpu-bound",
        flags: [],
        reasons: ["The CPU is the limit."],
        advice: [],
        nextAction: "Lower CPU-heavy options.",
        chosen: ["game priority High"],
        profileUsed: false,
      },
    };
    render(
      <SessionPanel
        session={session}
        game={game}
        minutes={1}
        log={[]}
        run={vi.fn() as never}
        pending={false}
        setOutcome={() => {}}
      />,
    );
    expect(screen.getByText("This session changed")).toBeInTheDocument();
    expect(screen.getByLabelText("Smart mode verdict")).toHaveTextContent(
      "The CPU is the limit.",
    );
    expect(screen.getByLabelText("Smart mode verdict")).toHaveTextContent(
      "Windows Game Mode is never changed",
    );
  });
});
