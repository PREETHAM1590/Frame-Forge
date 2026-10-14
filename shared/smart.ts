// Smart mode, the pure part: what a game's first minute of measurements says about its bottleneck, which mechanisms help in
// that case, and the plain-language verdict. Nothing here touches Windows; electron/smart.ts feeds it samples and applies the plan.
// Claims stay qualitative: Frameforge never says how many FPS a change will add.
import type {
  BottleneckKind,
  CustomMechanisms,
  SmartFlag,
  SmartVerdict,
} from "./contracts.js";

/** One second (or one five-second GPU read) of whole-PC measurements while the game runs. */
export interface SmartSample {
  cpuTotal: number;
  /** The busiest logical CPU. */
  maxCore: number;
  /** Logical CPUs at 90% or more. */
  saturatedCores: number;
  /** The busiest adapter's 3D engine, in percent. */
  gpu3d: number;
  /** The busiest adapter is the integrated GPU while a dedicated one exists. */
  busyAdapterIntegrated: boolean;
  memUsedPercent: number;
  availableBytes: number;
  gameWorkingSetBytes: number | null;
  /** CPU share of everything that is not the game, in percent of the whole CPU. */
  backgroundCpu: number;
  /** Current / maximum GPU graphics clock in percent, when nvidia-smi answered. */
  gpuClockPercent: number | null;
  gpuThrottled: string[];
  gpuTempC: number | null;
  /** Windows' "% Processor Performance": current clock as a percent of base. */
  cpuPerformance: number | null;
}

export interface FpsHint {
  avg: number;
  low1: number | null;
}
export interface Classification {
  kind: BottleneckKind;
  flags: SmartFlag[];
  reasons: string[];
  /** Fewer than this many samples were usable. */
  enough: boolean;
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const pct = (n: number) => `${Math.round(n)}%`;
export const minSamples = 20;

/** Slope of the game's memory use in bytes per sample (least squares), or null when it is unknown. */
export function growth(samples: readonly SmartSample[]): number | null {
  const ys = samples.map((s) => s.gameWorkingSetBytes);
  if (ys.some((y) => y === null) || ys.length < 10) return null;
  const xs = ys.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(ys as number[]);
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * ((ys[i] as number) - my);
    den += (x - mx) ** 2;
  });
  return den === 0 ? null : num / den;
}

export function classify(
  samples: readonly SmartSample[],
  fps: FpsHint | null = null,
): Classification {
  const reasons: string[] = [];
  const flags: SmartFlag[] = [];
  const enough = samples.length >= minSamples;
  if (!samples.length)
    return { kind: "unknown", flags, reasons: ["No measurements yet."], enough };
  const cpu = mean(samples.map((s) => s.cpuTotal));
  const core = mean(samples.map((s) => s.maxCore));
  const gpu = mean(samples.map((s) => s.gpu3d));
  const gpuSd = sd(samples.map((s) => s.gpu3d));
  const mem = mean(samples.map((s) => s.memUsedPercent));
  const free = mean(samples.map((s) => s.availableBytes)) / 1024 ** 3;
  const bg = mean(samples.map((s) => s.backgroundCpu));
  const clocks = samples
    .map((s) => s.gpuClockPercent)
    .filter((x): x is number => x !== null);
  const clock = clocks.length ? mean(clocks) : null;
  const throttled = samples.filter((s) =>
    s.gpuThrottled.some((r) => /thermal|power|brake|slowdown/.test(r)),
  ).length;
  const thermalReasons = samples.filter((s) =>
    s.gpuThrottled.some((r) => /thermal|brake/.test(r)),
  ).length;
  const perf = samples
    .map((s) => s.cpuPerformance)
    .filter((x): x is number => x !== null);
  const cpuPerf = perf.length ? mean(perf) : null;
  const saturated = mean(samples.map((s) => s.saturatedCores));

  const cpuHigh = core >= 85 || cpu >= 70 || saturated >= 1;
  reasons.push(
    `GPU ${pct(gpu)}, CPU ${pct(cpu)} (busiest core ${pct(core)}), memory ${pct(mem)} used.`,
  );

  // Flags: facts that sit next to the main class and change what helps.
  if (mem >= 88 || free < 1.5) {
    flags.push("memory-pressure");
    reasons.push(
      `Memory is tight: ${pct(mem)} used, about ${free.toFixed(1)} GB free.`,
    );
  }
  if (bg >= 12) {
    flags.push("background-load");
    reasons.push(
      `Other programs use about ${pct(bg)} of the CPU while you play.`,
    );
  }
  const heldBack =
    (clock !== null && clock < 70 && gpu >= 60) ||
    thermalReasons / samples.length >= 0.4 ||
    (cpuPerf !== null && cpuPerf < 60 && cpu >= 60);
  if (heldBack) {
    flags.push("thermal-limited");
    reasons.push(
      thermalReasons / samples.length >= 0.4
        ? "The GPU driver reports thermal limits during play."
        : cpuPerf !== null && cpuPerf < 60 && cpu >= 60
          ? `The CPU runs at only ${pct(cpuPerf)} of its base clock while busy.`
          : `The GPU clock sits at about ${pct(clock ?? 0)} of its maximum while busy.`,
    );
  } else if (throttled / samples.length >= 0.4)
    reasons.push(
      "The GPU reports a power limit for much of the time; on a laptop that is common and depends on the power mode.",
    );
  if (
    samples.filter((s) => s.busyAdapterIntegrated && s.gpu3d >= 40).length /
      samples.length >=
    0.5
  ) {
    flags.push("igpu-busy");
    reasons.push(
      "The busiest graphics adapter is the integrated GPU, not the dedicated one.",
    );
  }

  let kind: BottleneckKind;
  if (heldBack && (thermalReasons / samples.length >= 0.4 || (clock ?? 100) < 60)) {
    kind = "thermal";
  } else if (gpu >= 90) {
    kind = "gpu-bound";
    reasons.push("The GPU is the limit: it is working at nearly full load.");
  } else if (cpuHigh && gpu < 80) {
    kind = "cpu-bound";
    reasons.push(
      "The CPU is the limit: a core or the whole CPU is saturated while the GPU waits.",
    );
  } else if (flags.includes("memory-pressure") && gpu < 90) {
    kind = "memory";
    reasons.push("Neither chip is the limit, but memory is nearly full.");
  } else if (
    gpu >= 85 &&
    !cpuHigh
  ) {
    kind = "gpu-bound";
    reasons.push("The GPU is close to its limit and the CPU has room.");
  } else if (
    gpu < 75 &&
    core < 75 &&
    cpu < 50 &&
    gpuSd < 10 &&
    (fps === null || fps.low1 === null || fps.low1 / fps.avg >= 0.8)
  ) {
    kind = "frame-capped";
    reasons.push(
      fps
        ? `Steady low load and even frame times (${Math.round(fps.avg)} FPS average): the game looks capped by a frame limit, V-Sync or the menu.`
        : "Steady low load on both chips: the game looks capped by a frame limit, V-Sync or a menu screen.",
    );
  } else {
    kind = "unknown";
    reasons.push("The load does not point to one clear limit.");
  }
  if (!enough)
    reasons.push(
      `Only ${samples.length} seconds were measured, so treat this as a first guess.`,
    );
  return { kind, flags, reasons, enough };
}

export interface PlanContext {
  /** Windows will not open an administrator prompt for background steps unless the person allowed it. */
  gameWorkingSetGrowing: boolean;
  laptop: boolean;
  samples: number;
}
const none = (): CustomMechanisms => ({
  gameMode: false,
  priority: "Normal",
  affinity: null,
  powerPlan: false,
  lowerBackground: false,
  suspendBackground: false,
  closeBackground: false,
  timerResolution: false,
  pauseServices: false,
  gameBarCapture: false,
  smartCores: false,
  coreParking: false,
  powerThrottling: false,
  standbyPurge: false,
  gpuPriority: false,
});

const mechanismNames: Record<string, string> = {
  priority: "game priority",
  powerPlan: "performance power plan",
  lowerBackground: "lower background apps",
  suspendBackground: "pause background apps",
  closeBackground: "close background apps",
  timerResolution: "finer timer",
  pauseServices: "pause update and telemetry services",
  smartCores: "smart core targeting",
  coreParking: "core unparking",
  powerThrottling: "power-throttling opt-out",
  standbyPurge: "standby memory purge",
  gpuPriority: "GPU priority",
};
export const chosenNames = (m: CustomMechanisms) =>
  (Object.keys(mechanismNames) as (keyof typeof mechanismNames)[]).flatMap(
    (k) => {
      const value = (m as unknown as Record<string, unknown>)[k as string];
      return value && value !== "Normal"
        ? [
            k === "priority"
              ? `${mechanismNames[k]} ${value === "High" ? "High" : "Above normal"}`
              : mechanismNames[k]!,
          ]
        : [];
    },
  );

/**
 * Only the mechanisms that help this case. Windows' Game Mode setting is never touched. Standby purge is added only when
 * memory is really tight AND the game's own memory keeps growing, never as a routine.
 */
export function plan(
  c: Classification,
  ctx: PlanContext,
): {
  mechanisms: CustomMechanisms;
  advice: string[];
  nextAction: string;
  why: string[];
} {
  const m = none();
  const advice: string[] = [];
  const why: string[] = [];
  const has = (f: SmartFlag) => c.flags.includes(f);
  const background = () => {
    m.lowerBackground = true;
    m.suspendBackground = true;
  };
  switch (c.kind) {
    case "cpu-bound":
      m.priority = "High";
      m.powerPlan = true;
      m.timerResolution = true;
      m.coreParking = true;
      m.smartCores = true;
      m.powerThrottling = true;
      background();
      m.pauseServices = true;
      why.push(
        "CPU-bound: raised the game's priority, unparked cores, finer timer, power-throttling opt-out and eased competing background work.",
      );
      advice.push(
        "The CPU is the limit, so lowering graphics resolution will not help much. Lower CPU-heavy options (view distance, crowd or physics detail) instead.",
      );
      break;
    case "gpu-bound":
      m.priority = "AboveNormal";
      m.gpuPriority = true;
      m.powerPlan = true;
      m.powerThrottling = true;
      m.lowerBackground = true;
      m.closeBackground = false;
      why.push(
        "GPU-bound: raised GPU scheduling priority, kept a performance power plan and lowered background apps that compete for the GPU.",
      );
      advice.push(
        "The GPU is the limit. Lower resolution, turn on an upscaler (DLSS, FSR or XeSS) or reduce shadows and effects.",
      );
      break;
    case "memory":
      m.priority = "AboveNormal";
      m.powerThrottling = true;
      m.lowerBackground = true;
      m.suspendBackground = true;
      why.push(
        "Memory pressure: eased background apps so they stop competing for memory and CPU.",
      );
      advice.push(
        "Close browsers and large apps before playing; the app list on the Game Mode page shows which ones use the most memory.",
      );
      break;
    case "thermal":
      m.priority = "AboveNormal";
      m.powerPlan = true;
      m.powerThrottling = true;
      why.push(
        "Heat or power limits: made only light changes. Pushing harder would add heat.",
      );
      advice.push(
        "Raise the laptop for airflow, clear the vents and use the maker's performance mode. A cooling pad can help.",
      );
      break;
    case "frame-capped":
      m.priority = "AboveNormal";
      m.powerThrottling = true;
      why.push(
        "The game looks capped, so heavy changes would not show: kept a light setup.",
      );
      advice.push(
        "If you want more FPS, raise or remove the in-game frame limit and V-Sync. For smoother pacing, cap just below your screen's refresh rate.",
      );
      break;
    default:
      m.priority = "AboveNormal";
      m.powerThrottling = true;
      why.push("No clear bottleneck: applied only light, safe changes.");
  }
  if (has("memory-pressure")) {
    background();
    advice.push("Memory is tight: closing apps you do not need helps more than any setting.");
    if (ctx.gameWorkingSetGrowing) {
      m.standbyPurge = true;
      why.push(
        "Memory is tight and the game's memory keeps growing, so the standby list is cleared once at the start (asks for administrator approval).",
      );
    }
  }
  if (has("background-load")) {
    background();
    why.push("Background programs use noticeable CPU, so they are eased for the session.");
  }
  if (has("thermal-limited") && c.kind !== "thermal")
    advice.push(
      "Clocks are held back by heat or power limits: improve cooling and use the laptop's higher performance mode.",
    );
  if (has("igpu-busy"))
    advice.push(
      "The game seems to run on the integrated GPU. Set it to High performance in Windows Graphics settings (the Health Check can do this).",
    );
  // Smart mode never changes Windows Game Mode.
  m.gameMode = false;

  const nextAction = has("igpu-busy")
    ? "Make the game use the dedicated GPU (Health Check > Game graphics card)."
    : c.kind === "thermal"
      ? "Improve cooling and set the laptop to its highest performance mode."
      : c.kind === "gpu-bound"
        ? "Lower resolution or use DLSS/FSR/XeSS."
        : c.kind === "cpu-bound" && has("memory-pressure")
          ? "Close memory-hungry apps and consider a second memory module if you have only one."
          : c.kind === "cpu-bound"
            ? "Lower CPU-heavy in-game options; closing apps helps a little."
            : c.kind === "memory"
              ? "Close memory-hungry apps before playing."
              : c.kind === "frame-capped"
                ? "Check the frame limit and V-Sync if you want more FPS."
                : "Run Smart mode for a longer session to learn more.";
  return { mechanisms: m, advice, nextAction, why };
}

export function verdictOf(
  c: Classification,
  p: ReturnType<typeof plan>,
  profileUsed: boolean,
): SmartVerdict {
  return {
    classification: c.kind,
    flags: c.flags,
    reasons: [...c.reasons, ...p.why].slice(0, 12),
    advice: p.advice.slice(0, 8),
    nextAction: p.nextAction,
    chosen: chosenNames(p.mechanisms).slice(0, 20),
    profileUsed,
  };
}

/** Plain label for a class, for the UI and notifications. */
export const kindLabel: Record<BottleneckKind, string> = {
  "cpu-bound": "CPU-bound",
  "gpu-bound": "GPU-bound",
  memory: "Memory-limited",
  thermal: "Heat or power limited",
  "frame-capped": "Frame-capped",
  unknown: "No clear limit",
};

/** A short, stable text for the hardware a profile was learned on; a change re-runs the observation. */
export function fingerprintOf(parts: {
  cpu: string;
  gpus: { name: string; driver: string | null }[];
  ramBytes: number;
  sticks: number;
  ramMTs: number | null;
}): string {
  return [
    parts.cpu.trim(),
    ...parts.gpus.map((g) => `${g.name.trim()} ${g.driver ?? ""}`.trim()).sort(),
    `${Math.round(parts.ramBytes / 1024 ** 3)}GB x${parts.sticks} @${parts.ramMTs ?? "?"}`,
  ]
    .join(" | ")
    .slice(0, 400);
}

/** nvidia-smi --query-gpu=clocks.gr,clocks.max.gr,temperature.gpu,<throttle reasons> (csv, no header, no units). */
export function parseSmi(text: string): {
  clockPercent: number | null;
  tempC: number | null;
  throttled: string[];
} | null {
  const line = text.split("\n").find((l) => l.trim());
  if (!line) return null;
  const f = line.split(",").map((x) => x.trim());
  const n = (i: number) => {
    const v = Number(f[i]);
    return f[i] !== undefined && f[i] !== "" && Number.isFinite(v) ? v : null;
  };
  const clock = n(0);
  const max = n(1);
  const mask = /^0x[0-9a-f]+$/i.test(f[3] ?? "") ? BigInt(f[3]!) : 0n;
  const throttled: string[] = [];
  if (mask & 0x4n) throttled.push("power cap");
  if (mask & 0x8n) throttled.push("hardware slowdown");
  if (mask & 0x20n) throttled.push("thermal slowdown");
  if (mask & 0x40n) throttled.push("hardware thermal slowdown");
  if (mask & 0x80n) throttled.push("power brake");
  if (clock === null && n(2) === null) return null;
  return {
    clockPercent: clock !== null && max ? (clock / max) * 100 : null,
    tempC: n(2),
    throttled,
  };
}

// ---- hook for other parts of the app (per-game guides) ----
export type BottleneckShort = "cpu" | "gpu" | "memory" | "thermal" | "capped";
const short: Partial<Record<BottleneckKind, BottleneckShort>> = {
  "cpu-bound": "cpu",
  "gpu-bound": "gpu",
  memory: "memory",
  thermal: "thermal",
  "frame-capped": "capped",
};
let source: (gameId: string) => BottleneckKind | null = () => null;
/** The app registers where learned profiles live (electron/smart.ts does this when it starts). */
export function setBottleneckSource(
  fn: (gameId: string) => BottleneckKind | null,
) {
  source = fn;
}
/** The learned bottleneck for a game, or null when Smart mode has not classified it yet. */
export function bottleneckFor(gameId: string): BottleneckShort | null {
  const kind = source(gameId);
  return (kind && short[kind]) || null;
}
