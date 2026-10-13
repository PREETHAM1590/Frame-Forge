// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
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
  MechanismId,
  type AppEvent,
  type BoosterConfig,
  type FrameforgeApi,
  type MechanismId as Id,
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
type Cap = { available: boolean; detail: string; active: boolean };
const lime = (detail: string): Cap => ({
  available: true,
  detail,
  active: false,
});
const bad = (detail: string): Cap => ({
  available: false,
  detail,
  active: false,
});
function install(
  mode: BoosterConfig["mode"],
  caps: Partial<Record<Id, Cap>> = {},
  topology: object | null = {
    hybrid: true,
    performanceCores: 4,
    performanceThreads: 8,
    efficiencyCores: 4,
    efficiencyThreads: 4,
    dualCcdX3d: false,
    summary:
      "4 performance cores (8 threads) + 4 efficiency cores (4 threads).",
  },
) {
  const calls: { method: string; input: unknown }[] = [];
  const results: Record<string, unknown> = {};
  let booster: BoosterConfig = { ...defaultState.booster, mode };
  const bootstrap = () => ({
    state: { ...defaultState, games: [game], booster },
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
    capabilities: ["mouse-precision"],
    startupSupported: false,
    version: "test",
    mode: "desktop",
    boost: { session: null, available: true, watching: false },
  });
  const defaults: Partial<Record<Id, Cap>> = {
    pauseServices: lime(
      "6 running service(s) can be paused: DiagTrack, SysMain.",
    ),
    gameBarCapture: lime("Turns off AppCaptureEnabled for the session."),
    smartCores: lime("4 performance cores. The game is steered to 8 threads."),
    coreParking: lime("Plugged-in minimum unparked cores is 4%."),
    powerThrottling: lime("Asks Windows not to throttle."),
    gpuPreference: lime("2 graphics adapters found."),
    fullscreenOptimizations: lime("Opt-in advanced."),
  };
  const method = (name: string, answer: (input: never) => unknown) => [
    name,
    async (input: never) => {
      calls.push({ method: name, input });
      return answer(input);
    },
  ];
  window.frameforge = {
    ...Object.fromEntries([
      method("bootstrap", () => bootstrap()),
      method("boostConfig", (input: BoosterConfig) => {
        booster = input;
        return bootstrap().state;
      }),
      method("boostStatus", () => ({
        session: null,
        capabilities: {
          logicalCpus: 12,
          topology,
          mechanisms: MechanismId.options.map((id) => ({
            id,
            ...(caps[id] ?? defaults[id] ?? lime("ok")),
          })),
        },
        watching: false,
        ownedPowerPlan: false,
      })),
      method("boostStart", () => ({
        id: crypto.randomUUID(),
        gameId: game.id,
        mode: "competitive",
        target: {
          pid: 4,
          startTime: "2026-10-12T10:00:00.0000000Z",
          executablePath: "C:/Games/Test/game.exe",
          name: "game",
          priority: "Normal",
        },
        startedAt: "2026-10-13T10:00:00.000Z",
        endedAt: null,
        status: "active",
        message: "Competitive mode active.",
        mechanisms: [],
        samples: [],
        failed: false,
        abnormal: false,
      })),
      method("networkCheck", (input: { host: string }) => {
        if (results.networkError) throw new Error(String(results.networkError));
        return {
          host: input.host,
          address: "93.184.216.34",
          sent: 10,
          received: 9,
          lossPercent: 10,
          minMs: 11,
          avgMs: 13.2,
          maxMs: 20,
          jitterMs: 2.1,
          samples: [],
          message: "9 of 10 replies. ICMP to this host, not game traffic.",
        };
      }),
    ]),
    onEvent: (callback: (event: AppEvent) => void) => {
      void callback;
      return () => {};
    },
  } as unknown as FrameforgeApi;
  return { calls, results };
}
async function openGameMode() {
  render(<App />);
  await screen.findByText("Your setup, in focus.");
  fireEvent.click(screen.getByRole("button", { name: "Game Mode" }));
  await screen.findByRole("heading", { name: "Game Mode", level: 1 });
}
const card = (name: string) => screen.getByRole("article", { name });
beforeEach(() => {
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});
describe("new mechanisms on the mode cards", () => {
  it("shows per-PC applicability, the admin prompt and the detected CPU layout", async () => {
    install("balanced");
    await openGameMode();
    expect(
      await screen.findByLabelText("Detected CPU layout"),
    ).toHaveTextContent("4 performance cores (8 threads)");
    const competitive = await waitFor(() => {
      const c = card("Competitive on this PC");
      expect(within(c).getByText("Pause Windows services")).toBeVisible();
      return c;
    });
    expect(
      within(competitive).getByText("applies (asks for admin)"),
    ).toBeVisible();
    expect(within(competitive).getByText("Smart core targeting")).toBeVisible();
    expect(within(competitive).getByText("Disable core parking")).toBeVisible();
    // Next-launch settings say so on the card.
    expect(
      within(card("Balanced on this PC")).getByText("applies (next launch)"),
    ).toBeVisible();
    // Balanced and Performance never list the administrator step.
    expect(
      within(card("Performance on this PC")).queryByText(
        "Pause Windows services",
      ),
    ).toBeNull();
    expect(
      within(card("Balanced on this PC")).queryByText("Pause Windows services"),
    ).toBeNull();
  });
  it("labels what this PC cannot do as unsupported with the reason", async () => {
    install(
      "balanced",
      {
        smartCores: bad(
          "This CPU is not hybrid (all cores are the same type).",
        ),
        coreParking: bad("Dual-CCD Ryzen X3D parts rely on core parking."),
        gpuPreference: bad("Only one graphics adapter is installed."),
        pauseServices: bad(
          "None of the pausable services are running right now.",
        ),
      },
      {
        hybrid: false,
        performanceCores: 0,
        performanceThreads: 0,
        efficiencyCores: 0,
        efficiencyThreads: 0,
        dualCcdX3d: true,
        summary:
          "16 cores, 32 threads; all cores are the same type (not a hybrid CPU).",
      },
    );
    await openGameMode();
    const competitive = await waitFor(() => {
      const c = card("Competitive on this PC");
      expect(within(c).getAllByText("unsupported").length).toBeGreaterThan(2);
      return c;
    });
    expect(within(competitive).getByText("unavailable")).toBeVisible();
    expect(
      within(competitive).getByText(/Dual-CCD Ryzen X3D parts rely/),
    ).toBeVisible();
    expect(screen.getByLabelText("Detected CPU layout")).toHaveTextContent(
      "leaves your game's cores and core parking alone",
    );
    expect(
      within(competitive).getByText(/Changes \d+ of 12 on this PC/),
    ).toBeVisible();
  });
});
describe("custom toggles for the new mechanisms", () => {
  it("offers each toggle, disables the unsupported ones and explains the advanced one", async () => {
    install("custom", {
      smartCores: bad("This CPU is not hybrid."),
      gpuPreference: bad("Only one graphics adapter is installed."),
    });
    await openGameMode();
    const section = await screen.findByRole("region", {
      name: "Custom mechanisms",
    });
    for (const name of [
      /Game Bar capture off/,
      /Power throttling opt-out/,
      /Smart core targeting/,
      /Disable core parking/,
      /High-performance GPU preference/,
      /Pause Windows services/,
      /Fullscreen optimizations off/,
    ])
      expect(within(section).getByRole("switch", { name })).toBeVisible();
    await waitFor(() =>
      expect(
        within(section).getByRole("switch", { name: /Smart core targeting/ }),
      ).toBeDisabled(),
    );
    expect(
      within(section).getByRole("switch", { name: /High-performance GPU/ }),
    ).toBeDisabled();
    expect(
      within(section).getByRole("switch", { name: /Fullscreen optimizations/ }),
    ).toBeEnabled();
    expect(within(section).getByText(/lose Auto HDR/)).toBeVisible();
    expect(
      within(section).getByText(/Unsupported: This CPU is not hybrid/),
    ).toBeVisible();
  });
  it("saves a toggle through the existing boostConfig request", async () => {
    const { calls } = install("custom");
    await openGameMode();
    const section = await screen.findByRole("region", {
      name: "Custom mechanisms",
    });
    fireEvent.click(
      within(section).getByRole("switch", { name: /Game Bar capture off/ }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.method === "boostConfig")).toBe(true),
    );
    const saved = calls.find((c) => c.method === "boostConfig")!
      .input as BoosterConfig;
    expect(saved.custom.gameBarCapture).toBe(true);
    expect(saved.custom.pauseServices).toBe(false);
  });
});
describe("administrator prompt explanation", () => {
  it("explains the prompt before starting a mode that pauses services", async () => {
    const { calls } = install("competitive");
    await openGameMode();
    expect(
      await screen.findByText(/Pausing services needs administrator approval/),
    ).toBeVisible();
    const start = await screen.findByRole("button", { name: /Start boost/ });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/administrator prompt now, and another one/),
    ).toBeVisible();
    expect(calls.some((c) => c.method === "boostStart")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "boostStart")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Start boost/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Continue",
      }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.method === "boostStart")).toBe(true),
    );
  });
  it("starts a mode without services directly and without any explanation", async () => {
    const { calls } = install("performance");
    await openGameMode();
    expect(
      screen.queryByText(/Pausing services needs administrator/),
    ).toBeNull();
    const start = await screen.findByRole("button", { name: /Start boost/ });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "boostStart")).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("does not ask when services cannot be paused on this PC", async () => {
    const { calls } = install("competitive", {
      pauseServices: bad(
        "None of the pausable services are running right now.",
      ),
    });
    await openGameMode();
    await screen.findByText(/None of the pausable services/);
    const start = await screen.findByRole("button", { name: /Start boost/ });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "boostStart")).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
describe("network check", () => {
  it("only enables Check for a valid host and shows latency, jitter and loss", async () => {
    const { calls } = install("balanced");
    await openGameMode();
    const panel = await screen.findByRole("region", { name: "Network check" });
    const button = within(panel).getByRole("button", { name: "Check network" });
    expect(button).toBeDisabled();
    const input = within(panel).getByLabelText("Host name or IP address");
    fireEvent.change(input, { target: { value: "bad host!" } });
    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: "example.com" } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    const result = await within(panel).findByRole("status", {
      name: "Network check result",
    });
    expect(result).toHaveTextContent("9 of 10");
    expect(result).toHaveTextContent("10%");
    expect(result).toHaveTextContent("11 / 13.2 / 20 ms");
    expect(result).toHaveTextContent("2.1 ms");
    expect(calls.find((c) => c.method === "networkCheck")!.input).toEqual({
      host: "example.com",
      count: 10,
    });
    expect(within(panel).getByText(/not game servers/)).toBeVisible();
  });
  it("runs a labelled public reference target and shows a failure honestly", async () => {
    const { calls, results } = install("balanced");
    results.networkError = "The network check failed.";
    await openGameMode();
    const panel = await screen.findByRole("region", { name: "Network check" });
    fireEvent.click(
      within(panel).getByRole("button", {
        name: /Cloudflare DNS \(1\.1\.1\.1\)/,
      }),
    );
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "The network check failed.",
    );
    expect(calls.find((c) => c.method === "networkCheck")!.input).toEqual({
      host: "1.1.1.1",
      count: 10,
    });
    expect(within(panel).queryByRole("status")).toBeNull();
  });
});
