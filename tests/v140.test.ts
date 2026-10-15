import { describe, expect, it } from "vitest";
import { FpsAccumulator } from "../shared/fps";
import {
  benchCsv,
  benchMarkdown,
  compareBench,
  compareMetric,
  metrics,
  usable,
} from "../shared/benchmark";
import { summarizeSession } from "../shared/sessionChanges";
import { driverAge, driverPages } from "../shared/drivers";
import {
  effectiveSelection,
  formatBytes,
  needsShaderWarning,
  selectedBytes,
} from "../shared/cleanup";
import {
  CleanupPreviewSchema,
  type BenchReport,
  type CleanupPreview,
  type FpsSummary,
  type MechanismResult,
} from "../shared/contracts";
import { BoostNotices } from "../electron/background";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let seq = 1;
function run(
  boost: "on" | "off" | "mixed",
  avg: number,
  extra: Partial<FpsSummary> = {},
): FpsSummary {
  return {
    id: uuid(seq++),
    gameId: uuid(999),
    gameName: "Test Game",
    at: "2026-10-15T10:00:00.000Z",
    durationSeconds: 60,
    frames: 6000,
    avgFps: avg,
    low1Fps: avg * 0.7,
    low01Fps: avg * 0.5,
    p99Ms: 1000 / (avg * 0.7),
    stutters: 5,
    cpuPercent: 40,
    gpuPercent: 80,
    benchmarkSeconds: 60,
    boost,
    ...extra,
  };
}
const side = (boost: "on" | "off", values: number[]) =>
  values.map((v) => run(boost, v));

describe("frame statistics", () => {
  it("computes 0.1% low, p99 and stutters", () => {
    const acc = new FpsAccumulator();
    const frames = Array.from({ length: 2000 }, () => 10);
    frames[500] = 60;
    frames[1500] = 80;
    acc.add(frames);
    expect(acc.low01Fps).not.toBeNull();
    expect(acc.low01Fps!).toBeLessThan(acc.low1Fps!);
    expect(acc.p99Ms).toBeCloseTo(10, 0);
    expect(acc.stutters).toBe(2);
  });
  it("gives nothing for too few frames", () => {
    const acc = new FpsAccumulator();
    acc.add(Array.from({ length: 500 }, () => 16));
    expect(acc.low01Fps).toBeNull();
    expect(acc.low1Fps).not.toBeNull();
    const few = new FpsAccumulator();
    few.add([16, 16]);
    expect(few.p99Ms).toBeNull();
  });
  it("does not call fast, small frame time changes stutters", () => {
    const acc = new FpsAccumulator();
    acc.add(Array.from({ length: 300 }, (_, i) => (i === 150 ? 12 : 3)));
    expect(acc.stutters).toBe(0);
  });
});

describe("benchmark comparison", () => {
  it("says no measurable difference when the delta is inside the run spread", () => {
    const r = compareBench([
      ...side("off", [100, 104, 98, 102, 96]),
      ...side("on", [101, 99, 103, 97, 105]),
    ]);
    expect(r.enough).toBe(true);
    expect(r.rows[0]!.verdict).toBe("none");
    expect(r.headline).toMatch(/No measurable difference/);
  });
  it("reports a real gain only when it clears the spread", () => {
    const r = compareBench([
      ...side("off", [100, 101, 99, 100, 100]),
      ...side("on", [112, 111, 113, 112, 112]),
    ]);
    expect(r.rows[0]!.verdict).toBe("better");
    expect(r.rows[0]!.delta).toBeCloseTo(12, 5);
    expect(r.headline).toMatch(/Average FPS improved/);
  });
  it("calls lower frame time and stutter counts better when they fall", () => {
    const row = compareMetric(
      metrics.find((m) => m.key === "p99Ms")!,
      [20, 20.1, 19.9],
      [15, 15.1, 14.9],
    );
    expect(row.verdict).toBe("better");
  });
  it("calls a clear drop worse and utilization only changed", () => {
    const worse = compareMetric(metrics[0]!, [100, 101, 99], [80, 81, 79]);
    expect(worse.verdict).toBe("worse");
    const cpu = compareMetric(metrics[5]!, [40, 41, 39], [60, 61, 59]);
    expect(cpu.verdict).toBe("changed");
  });
  it("needs three runs per side and claims nothing with fewer", () => {
    const r = compareBench([
      ...side("off", [100, 100]),
      ...side("on", [150, 150]),
    ]);
    expect(r.enough).toBe(false);
    expect(r.rows[0]!.verdict).toBe("insufficient");
    expect(r.headline).toMatch(/Nothing is claimed/);
    expect(r.warnings[0]).toMatch(/at least 3/);
  });
  it("warns below five runs per side but still compares", () => {
    const r = compareBench([
      ...side("off", [100, 101, 99]),
      ...side("on", [120, 121, 119]),
    ]);
    expect(r.enough).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/5 each/);
    expect(r.rows[0]!.verdict).toBe("better");
  });
  it("leaves out mixed, short and untimed runs and says why", () => {
    const runs = [
      ...side("off", [100, 100, 100]),
      ...side("on", [100, 100, 100]),
      run("mixed", 200),
      run("on", 300, { durationSeconds: 20 }),
      run("on", 300, { benchmarkSeconds: null }),
    ];
    const r = compareBench(runs);
    expect(r.excluded).toHaveLength(3);
    expect(r.onRuns).toHaveLength(3);
    expect(usable(runs[6]!)).toBe("Game Mode changed during the run");
    expect(r.warnings.join(" ")).toMatch(/left out/);
  });
  it("applies the 1% floor when runs are identical", () => {
    const r = compareBench([
      ...side("off", [100, 100, 100]),
      ...side("on", [100.5, 100.5, 100.5]),
    ]);
    expect(r.rows[0]!.verdict).toBe("none");
  });
  it("handles old runs without the new metrics", () => {
    const old = (b: "on" | "off") =>
      run(b, 100, { low01Fps: undefined, p99Ms: null });
    const r = compareBench([
      old("off"),
      old("off"),
      old("off"),
      old("on"),
      old("on"),
      old("on"),
    ]);
    expect(r.rows.find((x) => x.metric.key === "p99Ms")!.verdict).toBe(
      "insufficient",
    );
  });
  it("exports markdown and CSV from measured numbers only", () => {
    const report: BenchReport = {
      id: uuid(500),
      gameId: uuid(999),
      gameName: "Test Game",
      at: "2026-10-15T10:00:00.000Z",
      runs: [...side("off", [100, 101, 99]), ...side("on", [100, 100, 101])],
    };
    const md = benchMarkdown(report);
    expect(md).toContain("| Average FPS |");
    expect(md).toContain("Noise note");
    expect(md).toMatch(/no measurable difference/);
    const csv = benchCsv(report).trim().split("\n");
    expect(csv).toHaveLength(7);
    expect(csv[0]).toContain("low01_fps");
  });
});

const m = (
  id: MechanismResult["id"],
  state: MechanismResult["state"],
  detail: string,
  code?: string,
): MechanismResult => ({ id, state, detail, ...(code ? { code } : {}) });

describe("This session changed", () => {
  it("lists applied, already set, skipped, unavailable and failed", () => {
    const s = summarizeSession({
      status: "active",
      mechanisms: [
        m(
          "priority",
          "applied",
          "game (pid 1): High priority verified (was Normal).",
        ),
        m(
          "gameMode",
          "skipped",
          "Windows Game Mode is already on.",
          "already-set",
        ),
        m("gameBarCapture", "skipped", "Already off by policy", "policy"),
        m("pauseServices", "skipped", "Not requested", "admin-not-requested"),
        m("timerResolution", "unsupported", "Needs a Windows setting"),
        m("powerPlan", "failed", "Windows did not keep the power plan."),
      ],
    });
    expect(s.applied).toBe(1);
    expect(s.notChanged).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.items[0]!.change).toEqual({ from: "Normal", to: "High" });
    expect(s.items.find((i) => i.id === "pauseServices")!.reason).toMatch(
      /administrator approval not requested/,
    );
    expect(s.headline).toMatch(
      /1 change applied, 4 already set\/skipped, 1 failed/,
    );
    expect(s.tray).toBe("1 change applied, 4 already set/skipped, 1 failed.");
  });
  it("says plainly when nothing material changed", () => {
    const s = summarizeSession({
      status: "ended",
      mechanisms: [
        m("gameMode", "skipped", "Windows Game Mode is already on."),
        m("priority", "skipped", "already runs at High", "already-set"),
      ],
    });
    expect(s.material).toBe(false);
    expect(s.headline).toBe(
      "This PC was already configured; expect little or no FPS difference.",
    );
    expect(s.items.every((i) => i.kind === "already")).toBe(true);
  });
  it("folds per-process rows and splits restore results", () => {
    const s = summarizeSession({
      status: "ended",
      restoreFrom: 3,
      mechanisms: [
        m(
          "lowerBackground",
          "applied",
          "a.exe (pid 1): priority changed from Normal to BelowNormal",
        ),
        m(
          "lowerBackground",
          "applied",
          "b.exe (pid 2): priority changed from Normal to BelowNormal",
        ),
        m(
          "gameMode",
          "applied",
          "Windows Game Mode was off; turned on and verified.",
        ),
        m("lowerBackground", "reverted", "restored"),
        m("gameMode", "failed", "could not restore"),
        m("gameMode", "conflict", "changed since"),
      ],
    });
    expect(s.items).toHaveLength(2);
    expect(s.applied).toBe(3);
    expect(s.items[0]!.more).toBe(1);
    expect(s.restored).toBe(1);
    expect(s.restoreIssues).toHaveLength(2);
  });
  it("handles an empty and a waiting session", () => {
    expect(
      summarizeSession({ status: "preparing", mechanisms: [] }).headline,
    ).toMatch(/No mechanism ran/);
    const w = summarizeSession({
      status: "active",
      mechanisms: [m("pauseServices", "pending", "waiting")],
    });
    expect(w.pending).toBe(1);
    expect(w.headline).toMatch(/Waiting for administrator/);
  });
  it("puts the summary in the tray notification", () => {
    const session = {
      id: uuid(1),
      gameId: uuid(2),
      mode: "balanced" as const,
      target: {
        pid: 1,
        startTime: "x",
        executablePath: "C:\\g.exe",
        name: "g.exe",
        priority: "Normal" as const,
      },
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      status: "ended" as const,
      message: "",
      mechanisms: [
        m("priority", "applied", "x"),
        m("gameMode", "skipped", "already on", "already-set"),
      ],
      samples: [],
      failed: false,
      abnormal: false,
    };
    const notices = new BoostNotices();
    notices.next({ ...session, status: "active" }, "G");
    expect(notices.next(session, "G")!.body).toContain(
      "1 change applied, 1 already set/skipped.",
    );
  });
});

describe("driver age", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  it("describes age and level", () => {
    expect(driverAge("2026-10-01", now)).toMatchObject({
      days: 14,
      level: "recent",
      text: "14 days old",
    });
    expect(driverAge("2026-03-01", now).level).toBe("aging");
    expect(driverAge("2025-01-01", now)).toMatchObject({
      level: "old",
      text: "21 months old",
    });
    expect(driverAge("2020-01-01", now).text).toBe("6 years old");
  });
  it("handles missing dates and the future", () => {
    expect(driverAge(null, now).level).toBe("unknown");
    expect(driverAge("garbage", now).days).toBeNull();
    expect(driverAge("2027-01-01", now).days).toBe(0);
  });
  it("only knows official https pages", () => {
    for (const url of Object.values(driverPages))
      expect(url).toMatch(/^https:\/\/www\.(nvidia|amd|intel)\.com\//);
  });
});

describe("cleanup preview and selection", () => {
  const row = (
    id: CleanupPreview["categories"][number]["id"],
    over: Partial<CleanupPreview["categories"][number]> = {},
  ) => ({
    id,
    label: id,
    present: true,
    needsAdmin: false,
    shader: false,
    minAgeHours: 0,
    bytes: 1024 * 1024,
    files: 3,
    folders: [],
    ...over,
  });
  const preview: CleanupPreview = {
    elevated: false,
    categories: [
      row("userTemp", { bytes: 2048 }),
      row("windowsTemp", { needsAdmin: true, bytes: null }),
      row("directxShaders", { shader: true, bytes: 4096 }),
      row("nvidiaShaders", { present: false, shader: true, bytes: 0 }),
    ],
  };
  it("matches the schema", () => {
    expect(CleanupPreviewSchema.safeParse(preview).success).toBe(true);
  });
  it("only selects present categories Frameforge may clean", () => {
    expect(
      effectiveSelection(preview, ["windowsTemp", "nvidiaShaders", "userTemp"]),
    ).toEqual(["userTemp"]);
    expect(
      selectedBytes(preview, ["userTemp", "directxShaders", "windowsTemp"]),
    ).toBe(6144);
  });
  it("warns about stutter only when a usable shader cache is selected", () => {
    expect(needsShaderWarning(preview, ["userTemp"])).toBe(false);
    expect(needsShaderWarning(preview, ["nvidiaShaders"])).toBe(false);
    expect(needsShaderWarning(preview, ["directxShaders"])).toBe(true);
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});
