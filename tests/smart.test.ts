import { afterEach, describe, expect, it } from "vitest";
import {
  bottleneckFor,
  classify,
  fingerprintOf,
  growth,
  parseSmi,
  plan,
  setBottleneckSource,
  verdictOf,
  type SmartSample,
} from "../shared/smart";
import { SmartVerdictSchema } from "../shared/contracts";

const GB = 1024 ** 3;
const base: SmartSample = {
  cpuTotal: 30,
  maxCore: 40,
  saturatedCores: 0,
  gpu3d: 40,
  busyAdapterIntegrated: false,
  memUsedPercent: 55,
  availableBytes: 7 * GB,
  gameWorkingSetBytes: 3 * GB,
  backgroundCpu: 3,
  gpuClockPercent: 95,
  gpuThrottled: [],
  gpuTempC: 65,
  cpuPerformance: 100,
};
const run = (
  n: number,
  over: Partial<SmartSample> | ((i: number) => Partial<SmartSample>) = {},
) =>
  Array.from({ length: n }, (_, i) => ({
    ...base,
    ...(typeof over === "function" ? over(i) : over),
  }));

describe("bottleneck classifier", () => {
  it("GPU-bound: GPU at 90% or more", () => {
    const c = classify(run(60, { gpu3d: 96, cpuTotal: 35, maxCore: 60 }));
    expect(c.kind).toBe("gpu-bound");
  });

  it("CPU-bound: GPU waits while a core is saturated", () => {
    const c = classify(
      run(60, { gpu3d: 40, cpuTotal: 60, maxCore: 98, saturatedCores: 2 }),
    );
    expect(c.kind).toBe("cpu-bound");
    expect(c.reasons.join(" ")).toMatch(/CPU is the limit/);
  });

  it("memory pressure alone: neither chip is busy but RAM is full", () => {
    const c = classify(
      run(60, {
        memUsedPercent: 94,
        availableBytes: 0.8 * GB,
        gpu3d: 55,
        maxCore: 60,
        cpuTotal: 40,
      }),
    );
    expect(c.kind).toBe("memory");
    expect(c.flags).toContain("memory-pressure");
  });

  it("thermal or power limited: clocks held back with thermal flags", () => {
    const c = classify(
      run(60, {
        gpu3d: 88,
        gpuClockPercent: 52,
        gpuThrottled: ["thermal slowdown"],
        gpuTempC: 90,
      }),
    );
    expect(c.kind).toBe("thermal");
    expect(c.flags).toContain("thermal-limited");
  });

  it("frame-capped: steady low load, and flat frame times when FPS is known", () => {
    const quiet = run(60, { gpu3d: 45, cpuTotal: 25, maxCore: 50 });
    expect(classify(quiet).kind).toBe("frame-capped");
    expect(classify(quiet, { avg: 144, low1: 138 }).kind).toBe("frame-capped");
    // Uneven frame times are not a cap.
    expect(classify(quiet, { avg: 144, low1: 50 }).kind).not.toBe(
      "frame-capped",
    );
  });

  it("unknown: too little data or no clear limit", () => {
    expect(classify([]).kind).toBe("unknown");
    expect(classify(run(5)).enough).toBe(false);
    const mixed = classify(
      run(60, (i) => ({ gpu3d: i % 2 ? 20 : 70, cpuTotal: 55, maxCore: 70 })),
    );
    expect(mixed.kind).toBe("unknown");
  });

  it("CPU-bound plus high RAM plus background load combine as flags (this PC's case)", () => {
    const c = classify(
      run(60, {
        gpu3d: 20,
        cpuTotal: 85,
        maxCore: 97,
        saturatedCores: 3,
        memUsedPercent: 93,
        availableBytes: 1 * GB,
        backgroundCpu: 22,
      }),
    );
    expect(c.kind).toBe("cpu-bound");
    expect(c.flags).toEqual(
      expect.arrayContaining(["memory-pressure", "background-load"]),
    );
    const p = plan(c, {
      gameWorkingSetGrowing: false,
      laptop: true,
      samples: 60,
    });
    expect(p.mechanisms).toMatchObject({
      priority: "High",
      lowerBackground: true,
      suspendBackground: true,
      pauseServices: true,
      coreParking: true,
      timerResolution: true,
      smartCores: true,
      powerThrottling: true,
      gpuPriority: false,
    });
    // Memory is tight but the game is not growing: no purge.
    expect(p.mechanisms.standbyPurge).toBe(false);
    expect(p.advice.join(" ")).toMatch(/second memory module|Memory is tight/);
    expect(p.why.join(" ")).toMatch(/CPU-bound/);
  });

  it("flags the integrated GPU doing the work", () => {
    const c = classify(run(60, { gpu3d: 70, busyAdapterIntegrated: true }));
    expect(c.flags).toContain("igpu-busy");
    const p = plan(c, {
      gameWorkingSetGrowing: false,
      laptop: true,
      samples: 60,
    });
    expect(p.nextAction).toMatch(/dedicated GPU/);
  });
});

describe("what Smart mode applies", () => {
  const ctx = { gameWorkingSetGrowing: false, laptop: false, samples: 60 };
  it("GPU-bound: GPU priority and a performance plan, no CPU tricks, and resolution advice", () => {
    const p = plan(classify(run(60, { gpu3d: 97 })), ctx);
    expect(p.mechanisms).toMatchObject({
      gpuPriority: true,
      powerPlan: true,
      coreParking: false,
      timerResolution: false,
      pauseServices: false,
    });
    expect(p.advice.join(" ")).toMatch(/resolution|upscaler/);
  });

  it("never touches Windows Game Mode, whatever the class", () => {
    for (const over of [
      { gpu3d: 97 },
      { gpu3d: 20, maxCore: 99, cpuTotal: 80, saturatedCores: 2 },
      { gpu3d: 45 },
    ])
      expect(plan(classify(run(60, over)), ctx).mechanisms.gameMode).toBe(
        false,
      );
  });

  it("thermal: light changes and cooling advice only", () => {
    const p = plan(
      classify(
        run(60, {
          gpu3d: 88,
          gpuClockPercent: 50,
          gpuThrottled: ["thermal slowdown"],
        }),
      ),
      ctx,
    );
    expect(p.mechanisms).toMatchObject({
      coreParking: false,
      timerResolution: false,
      gpuPriority: false,
    });
    expect(p.advice.join(" ")).toMatch(/airflow|cooling/);
  });

  it("standby purge only when memory is tight AND the game's memory keeps growing", () => {
    const tight = classify(
      run(60, {
        memUsedPercent: 95,
        availableBytes: 0.5 * GB,
        gpu3d: 50,
        maxCore: 60,
        cpuTotal: 40,
      }),
    );
    expect(plan(tight, ctx).mechanisms.standbyPurge).toBe(false);
    expect(
      plan(tight, { ...ctx, gameWorkingSetGrowing: true }).mechanisms
        .standbyPurge,
    ).toBe(true);
    // Growing memory without pressure never purges.
    const roomy = classify(run(60, { gpu3d: 97 }));
    expect(
      plan(roomy, { ...ctx, gameWorkingSetGrowing: true }).mechanisms
        .standbyPurge,
    ).toBe(false);
  });

  it("detects a growing working set", () => {
    expect(
      growth(
        run(30, (i) => ({ gameWorkingSetBytes: 2 * GB + i * 20 * 1024 ** 2 })),
      )!,
    ).toBeGreaterThan(1024 ** 2);
    expect(growth(run(30))).toBe(0);
    expect(growth(run(5))).toBeNull();
  });

  it("produces a verdict that satisfies the contract and stays qualitative", () => {
    const c = classify(run(60, { gpu3d: 97 }));
    const p = plan(c, ctx);
    const v = verdictOf(c, p, false);
    expect(() => SmartVerdictSchema.parse(v)).not.toThrow();
    expect(JSON.stringify(v)).not.toMatch(/\+\d+\s?%|more FPS/i);
    expect(v.chosen.join(" ")).not.toMatch(/Game Mode/i);
  });
});

describe("helpers", () => {
  afterEach(() => setBottleneckSource(() => null));
  it("parses nvidia-smi clock, temperature and throttle reasons", () => {
    expect(parseSmi("2610, 3105, 59, 0x0000000000000024\n")).toEqual({
      clockPercent: (2610 / 3105) * 100,
      tempC: 59,
      throttled: ["power cap", "thermal slowdown"],
    });
    expect(parseSmi("2610, 3105, 59\n")?.throttled).toEqual([]);
    expect(parseSmi("")).toBeNull();
    expect(parseSmi("[N/A], [N/A], [N/A]")).toBeNull();
  });
  it("fingerprints hardware and driver so a change re-runs the observation", () => {
    const a = fingerprintOf({
      cpu: "i5",
      gpus: [{ name: "RTX", driver: "1" }],
      ramBytes: 16 * GB,
      sticks: 1,
      ramMTs: 5200,
    });
    const b = fingerprintOf({
      cpu: "i5",
      gpus: [{ name: "RTX", driver: "2" }],
      ramBytes: 16 * GB,
      sticks: 1,
      ramMTs: 5200,
    });
    expect(a).not.toBe(b);
    expect(a).toBe(
      fingerprintOf({
        cpu: "i5",
        gpus: [{ name: "RTX", driver: "1" }],
        ramBytes: 16 * GB,
        sticks: 1,
        ramMTs: 5200,
      }),
    );
  });
  it("exposes the learned bottleneck for per-game guides", () => {
    expect(bottleneckFor("x")).toBeNull();
    setBottleneckSource((id) =>
      id === "x" ? "cpu-bound" : id === "y" ? "frame-capped" : null,
    );
    expect(bottleneckFor("x")).toBe("cpu");
    expect(bottleneckFor("y")).toBe("capped");
    expect(bottleneckFor("z")).toBeNull();
  });
});
