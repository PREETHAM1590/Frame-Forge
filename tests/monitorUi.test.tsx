// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Monitor } from "../src/views/Monitor";
import { FpsHistory } from "../src/views/monitor/GameMonitor";
import { linePoints } from "../src/views/monitor/Charts";
import {
  formatLink,
  formatRate,
  formatSize,
} from "../src/views/monitor/format";
import {
  defaultState,
  type AppEvent,
  type Bootstrap,
  type FpsStatus,
  type FpsSummary,
  type FrameforgeApi,
  type MonitorSample,
} from "../shared/contracts";
import type { ViewProps } from "../src/types";

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
const sample = (cpu = 12.5): MonitorSample => ({
  at: new Date().toISOString(),
  counters: true,
  cpu: { total: cpu, cores: [10, cpu, 99] },
  memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 },
  gpu: {
    available: true,
    detail: null,
    adapters: [
      {
        id: "0x0_0x1",
        engine3d: 41,
        compute: 2,
        copy: 3,
        video: 0,
        dedicatedBytes: 2 * 1024 ** 3,
        sharedBytes: 100 * 1024 ** 2,
      },
    ],
  },
  disks: [
    {
      name: "0 C:",
      readBytesPerSec: 5 * 1024 ** 2,
      writeBytesPerSec: 1024,
      activePercent: 12,
    },
  ],
  network: [
    {
      name: "Realtek PCIe GbE",
      downBytesPerSec: 2048,
      upBytesPerSec: 1024,
      linkBitsPerSec: 1e9,
    },
  ],
  processes: {
    byCpu: [
      { name: "chrome", count: 3, cpuPercent: 8.5, workingSetBytes: 1024 ** 3 },
    ],
    byMemory: [
      {
        name: "brave",
        count: 1,
        cpuPercent: 1,
        workingSetBytes: 2 * 1024 ** 3,
      },
    ],
  },
  temperatures: {
    gpu: [{ name: "RTX", celsius: 59 }],
    cpuCelsius: null,
    note: "Not available without a kernel driver. Frameforge does not install one.",
  },
});
const fpsStatus = (over: Partial<FpsStatus> = {}): FpsStatus => ({
  state: "idle",
  gameId: null,
  gameName: null,
  code: null,
  detail: "No FPS capture is running.",
  elapsedSeconds: 0,
  fps: null,
  avgFps: null,
  low1Fps: null,
  frames: 0,
  frameTimes: [],
  fpsHistory: [],
  usage: null,
  boost: "off",
  saved: null,
  running: [],
  ...over,
});
const summary = (): FpsSummary => ({
  id: crypto.randomUUID(),
  gameId: game.id,
  gameName: game.name,
  at: "2026-10-14T10:00:00.000Z",
  durationSeconds: 125,
  frames: 9000,
  avgFps: 87.4,
  low1Fps: 61.2,
  boost: "on",
});
type Calls = { method: string; input: unknown }[];
function install(
  answers: Partial<Record<string, (input: unknown) => unknown>> = {},
) {
  const listeners = new Set<(e: AppEvent) => void>();
  const calls: Calls = [];
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
          if (method === "fpsStatus") return fpsStatus();
          if (method === "fpsHistory") return [];
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
    listeners,
    count: (m: string) => calls.filter((c) => c.method === m).length,
  };
}
let visibility: DocumentVisibilityState = "visible";
const setVisibility = (v: DocumentVisibilityState) =>
  act(() => {
    visibility = v;
    document.dispatchEvent(new Event("visibilitychange"));
  });
const props = (over: Partial<Bootstrap["boost"]> = {}) =>
  ({
    data: {
      state: { ...defaultState, games: [game] },
      boost: { session: null, available: true, watching: false, ...over },
    },
  }) as unknown as ViewProps;
beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { frameforge?: unknown }).frameforge;
});

describe("Monitor sampling lifecycle", () => {
  it("starts when shown, stops completely when hidden, resumes when shown and stops on leaving", async () => {
    const api = install();
    const view = render(<Monitor {...props()} />);
    await waitFor(() => expect(api.count("monitorStart")).toBe(1));
    expect(api.count("monitorStop")).toBe(0);
    expect(api.listeners.size).toBeGreaterThan(0);
    await setVisibility("hidden");
    await waitFor(() => expect(api.count("monitorStop")).toBe(1));
    // Hidden: the page no longer listens for samples either.
    const before = api.listeners.size;
    api.emit({ type: "monitor", sample: sample(77) });
    expect(screen.queryByText("77%")).toBeNull();
    expect(before).toBeLessThan(3);
    await setVisibility("visible");
    await waitFor(() => expect(api.count("monitorStart")).toBe(2));
    view.unmount();
    await waitFor(() => expect(api.count("monitorStop")).toBe(2));
  });
  it("shows a reading, every section and an honest temperature note", async () => {
    const api = install();
    render(<Monitor {...props()} />);
    await waitFor(() => expect(api.count("monitorStart")).toBe(1));
    expect(screen.getByText("Reading the first sample...")).toBeInTheDocument();
    api.emit({ type: "monitor", sample: sample(12.5) });
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getAllByText("13%").length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: /CPU 13%/ })).toBeInTheDocument();
    expect(screen.getByText("3 logical cores")).toBeInTheDocument();
    expect(screen.getByText("GPU 0")).toBeInTheDocument();
    expect(screen.getByText("0 C:")).toBeInTheDocument();
    expect(screen.getByText("Realtek PCIe GbE")).toBeInTheDocument();
    expect(screen.getByText(/Link speed 1 Gbit\/s/)).toBeInTheDocument();
    expect(screen.getByText("chrome")).toBeInTheDocument();
    expect(screen.getByText("brave")).toBeInTheDocument();
    expect(
      screen.getByText(/Not available without a kernel driver/),
    ).toBeInTheDocument();
    expect(screen.getByText(/59/)).toBeInTheDocument();
  });
  it("tells the person when the monitor cannot start and offers a retry", async () => {
    const api = install({
      monitorStart: () => {
        throw new Error("The live monitor needs the Windows helper.");
      },
    });
    render(<Monitor {...props()} />);
    expect(
      await screen.findByText("The live monitor is not available"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The live monitor needs the Windows helper."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(api.count("monitorStart")).toBe(2));
  });
  it("reports a stalled helper after a few seconds without readings", async () => {
    install();
    vi.useFakeTimers();
    render(<Monitor {...props()} />);
    await act(async () => {
      vi.advanceTimersByTime(6100);
    });
    expect(
      screen.getByText("No readings for a few seconds"),
    ).toBeInTheDocument();
  });
});

describe("Game monitor", () => {
  it("starts a capture only on a click and shows the approval wait", async () => {
    const api = install({
      fpsStatus: () => fpsStatus({ running: [game.id] }),
      fpsStart: () =>
        fpsStatus({
          state: "starting",
          gameId: game.id,
          gameName: game.name,
          detail: "Waiting for Windows administrator approval.",
          running: [game.id],
        }),
    });
    render(<Monitor {...props()} />);
    const start = await screen.findByRole("button", {
      name: /start fps capture/i,
    });
    await waitFor(() => expect(start).toBeEnabled());
    expect(api.count("fpsStart")).toBe(0);
    fireEvent.click(start);
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === "fpsStart")?.input).toEqual({
        gameId: game.id,
        confirmed: true,
      }),
    );
    expect(
      await screen.findAllByText(/administrator approval/i),
    ).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });
  it("cannot start while the game is not running", async () => {
    install();
    render(<Monitor {...props()} />);
    const start = await screen.findByRole("button", {
      name: /start fps capture/i,
    });
    expect(start).toBeDisabled();
    expect(screen.getByText(/it is not running now/)).toBeInTheDocument();
  });
  it("shows live FPS, 1% low, frame graph and the game's usage", async () => {
    const api = install({ fpsStatus: () => fpsStatus({ running: [game.id] }) });
    render(<Monitor {...props()} />);
    await screen.findByRole("button", { name: /start fps capture/i });
    api.emit({
      type: "fps",
      status: fpsStatus({
        state: "capturing",
        gameId: game.id,
        gameName: game.name,
        detail: "Measuring.",
        fps: 143.6,
        avgFps: 120,
        low1Fps: 88,
        frames: 4321,
        elapsedSeconds: 75,
        frameTimes: [7, 7, 8, 30],
        fpsHistory: [120, 143],
        usage: {
          cpuPercent: 31.5,
          workingSetBytes: 2 * 1024 ** 3,
          gpuPercent: 77,
        },
        boost: "on",
      }),
    });
    expect(screen.getByText("Measuring")).toBeInTheDocument();
    expect(screen.getByText("144")).toBeInTheDocument();
    expect(screen.getByText("88")).toBeInTheDocument();
    expect(screen.getByText("4,321")).toBeInTheDocument();
    expect(screen.getByText("1 min 15 s")).toBeInTheDocument();
    expect(screen.getByText(/CPU 32%/)).toBeInTheDocument();
    expect(screen.getByText(/GPU 77%/)).toBeInTheDocument();
    expect(screen.getByText("Game Mode on")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /stop capture/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Frame time/ })).toBeInTheDocument();
  });
  it.each([
    ["declined", "Administrator approval was declined. Nothing was changed."],
    ["protected", "Windows will not let Frameforge inspect this game."],
    [
      "no-frames",
      "No frames seen yet. Only DirectX 9/10/11/12 games are measured.",
    ],
  ])("shows the honest %s state", async (code, detail) => {
    const api = install();
    render(<Monitor {...props()} />);
    await screen.findByRole("button", { name: /start fps capture/i });
    api.emit({
      type: "fps",
      status: fpsStatus({
        state: code === "no-frames" ? "capturing" : "unavailable",
        code,
        detail,
      }),
    });
    expect(screen.getByText(detail)).toBeInTheDocument();
  });
  it("lists saved captures for the game without claiming a gain", async () => {
    install({ fpsHistory: () => [summary()] });
    render(<FpsHistory gameId={game.id} />);
    expect(await screen.findByText("87 FPS")).toBeInTheDocument();
    expect(screen.getByText("61 FPS")).toBeInTheDocument();
    expect(screen.getByText("2 min 5 s")).toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText(/does not promise a gain/)).toBeInTheDocument();
  });
  it("renders nothing when there is no history", async () => {
    const api = install();
    const view = render(<FpsHistory gameId={game.id} />);
    await waitFor(() => expect(api.count("fpsHistory")).toBe(1));
    expect(view.container).toBeEmptyDOMElement();
  });
});

describe("chart and formatting helpers", () => {
  it("places the newest reading at the right edge and clamps to the chart", () => {
    const points = linePoints([0, 50, 200], 100, 60);
    expect(points[2][0]).toBe(300);
    expect(points[0][0]).toBeCloseTo(300 - 2 * (300 / 59), 0);
    // 0 is the bottom, over-range is the top, never outside the box.
    expect(points[0][1]).toBeGreaterThan(points[1][1]);
    expect(points[2][1]).toBeGreaterThanOrEqual(0);
    expect(points[0][1]).toBeLessThanOrEqual(64);
  });
  it("formats sizes, rates and link speeds", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatRate(2048)).toBe("2.0 KB/s");
    expect(formatLink(1e9)).toBe("1 Gbit/s");
    expect(formatLink(409500000)).toBe("410 Mbit/s");
  });
});
