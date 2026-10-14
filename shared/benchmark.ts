// A/B benchmark maths: timed runs with Game Mode off versus on, compared against their own run-to-run spread.
// Nothing here estimates or projects: a difference is reported only when it is larger than the noise seen in the runs themselves.
import type { BenchReport, FpsSummary } from "./contracts.js";

export const recommendedRuns = 5;
export const minimumRuns = 3;
/** A run shorter than this share of its planned length was stopped early and is left out. */
export const minRunShare = 0.9;
/** Differences under this share of the baseline are never called real, however quiet the runs were. */
export const relativeFloor = 0.01;

export type Direction = "higher" | "lower" | "neutral";
export interface MetricDef {
  key:
    | "avgFps"
    | "low1Fps"
    | "low01Fps"
    | "p99Ms"
    | "stutters"
    | "cpuPercent"
    | "gpuPercent";
  label: string;
  unit: string;
  /** Which direction is better; "neutral" is shown but never called better or worse. */
  better: Direction;
  digits: number;
}
export const metrics: MetricDef[] = [
  {
    key: "avgFps",
    label: "Average FPS",
    unit: "FPS",
    better: "higher",
    digits: 1,
  },
  { key: "low1Fps", label: "1% low", unit: "FPS", better: "higher", digits: 1 },
  {
    key: "low01Fps",
    label: "0.1% low",
    unit: "FPS",
    better: "higher",
    digits: 1,
  },
  {
    key: "p99Ms",
    label: "Frame time p99",
    unit: "ms",
    better: "lower",
    digits: 2,
  },
  { key: "stutters", label: "Stutters", unit: "", better: "lower", digits: 0 },
  {
    key: "cpuPercent",
    label: "Game CPU use",
    unit: "%",
    better: "neutral",
    digits: 1,
  },
  {
    key: "gpuPercent",
    label: "Game GPU use",
    unit: "%",
    better: "neutral",
    digits: 1,
  },
];

export const mean = (v: readonly number[]) =>
  v.reduce((a, b) => a + b, 0) / v.length;
/** Sample standard deviation; 0 for fewer than two values. */
export const stdev = (v: readonly number[]) => {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
};
export const range = (v: readonly number[]) =>
  v.length ? Math.max(...v) - Math.min(...v) : 0;

export type Verdict = "better" | "worse" | "changed" | "none" | "insufficient";
export interface Side {
  n: number;
  mean: number;
  stdev: number;
  min: number;
  max: number;
}
export interface Row {
  metric: MetricDef;
  off: Side | null;
  on: Side | null;
  delta: number | null;
  deltaPercent: number | null;
  /** The size a difference must exceed to count: the larger of the runs' min-max spread, twice the standard error and the 1% floor. */
  threshold: number | null;
  verdict: Verdict;
}

const side = (v: number[]): Side | null =>
  v.length
    ? {
        n: v.length,
        mean: mean(v),
        stdev: stdev(v),
        min: Math.min(...v),
        max: Math.max(...v),
      }
    : null;

/** Compares one metric. Fewer than three runs on either side is never enough to call anything. */
export function compareMetric(
  def: MetricDef,
  off: number[],
  on: number[],
): Row {
  const a = side(off);
  const b = side(on);
  if (!a || !b || a.n < minimumRuns || b.n < minimumRuns)
    return {
      metric: def,
      off: a,
      on: b,
      delta: a && b ? b.mean - a.mean : null,
      deltaPercent: null,
      threshold: null,
      verdict: "insufficient",
    };
  const delta = b.mean - a.mean;
  const se = Math.sqrt(a.stdev ** 2 / a.n + b.stdev ** 2 / b.n);
  const threshold = Math.max(
    range(off),
    range(on),
    2 * se,
    Math.abs(a.mean) * relativeFloor,
  );
  const deltaPercent = a.mean ? (delta / a.mean) * 100 : null;
  let verdict: Verdict = "none";
  if (Math.abs(delta) > threshold)
    verdict =
      def.better === "neutral"
        ? "changed"
        : delta > 0 === (def.better === "higher")
          ? "better"
          : "worse";
  return {
    metric: def,
    off: a,
    on: b,
    delta,
    deltaPercent,
    threshold,
    verdict,
  };
}

export interface BenchResult {
  offRuns: FpsSummary[];
  onRuns: FpsSummary[];
  excluded: { id: string; reason: string }[];
  warnings: string[];
  rows: Row[];
  /** True when both sides have the minimum number of runs. */
  enough: boolean;
  headline: string;
}

/** A timed run counts when it ran to (nearly) its planned length with Game Mode steady on or off. */
export function usable(run: FpsSummary): string | null {
  if (!run.benchmarkSeconds) return "not a timed benchmark run";
  if (run.boost === "mixed") return "Game Mode changed during the run";
  if (run.durationSeconds < run.benchmarkSeconds * minRunShare)
    return "stopped early";
  return null;
}

const fmt = (n: number, digits: number) => n.toFixed(digits);

export function compareBench(runs: readonly FpsSummary[]): BenchResult {
  const excluded: BenchResult["excluded"] = [];
  const offRuns: FpsSummary[] = [];
  const onRuns: FpsSummary[] = [];
  for (const run of runs) {
    const why = usable(run);
    if (why) excluded.push({ id: run.id, reason: why });
    else (run.boost === "on" ? onRuns : offRuns).push(run);
  }
  const rows = metrics.map((m) => {
    const pick = (list: FpsSummary[]) =>
      list
        .map((r) => r[m.key])
        .filter(
          (x): x is number => typeof x === "number" && Number.isFinite(x),
        );
    return compareMetric(m, pick(offRuns), pick(onRuns));
  });
  const enough = offRuns.length >= minimumRuns && onRuns.length >= minimumRuns;
  const warnings: string[] = [];
  if (!enough)
    warnings.push(
      `Needs at least ${minimumRuns} runs with Game Mode off and ${minimumRuns} with it on (you have ${offRuns.length} and ${onRuns.length}); ${recommendedRuns} each is recommended.`,
    );
  else if (offRuns.length < recommendedRuns || onRuns.length < recommendedRuns)
    warnings.push(
      `Only ${offRuns.length} off and ${onRuns.length} on runs: ${recommendedRuns} each gives a more trustworthy spread.`,
    );
  if (excluded.length)
    warnings.push(
      `${excluded.length} run(s) left out: ${[...new Set(excluded.map((e) => e.reason))].join("; ")}.`,
    );
  const avg = rows[0]!;
  const low = rows[1]!;
  let headline: string;
  if (!enough)
    headline =
      "Not enough runs to tell a real difference from run-to-run noise. Nothing is claimed.";
  else {
    const sig = [avg, low].filter(
      (r) => r.verdict === "better" || r.verdict === "worse",
    );
    if (!sig.length)
      headline =
        "No measurable difference: the change in average FPS and 1% lows is within the spread between runs.";
    else
      headline = sig
        .map(
          (r) =>
            `${r.metric.label} ${r.verdict === "better" ? "improved" : "got worse"} by ${fmt(Math.abs(r.delta!), 1)} ${r.metric.unit} (${fmt(Math.abs(r.deltaPercent ?? 0), 1)}%), larger than the ${fmt(r.threshold!, 1)} ${r.metric.unit} spread seen in these runs.`,
        )
        .join(" ");
  }
  return { offRuns, onRuns, excluded, warnings, rows, enough, headline };
}

const verdictText: Record<Verdict, string> = {
  better: "better",
  worse: "worse",
  changed: "changed",
  none: "no measurable difference",
  insufficient: "not enough runs",
};
export const verdictLabel = (v: Verdict) => verdictText[v];

const cell = (s: Side | null, d: number) =>
  s
    ? `${fmt(s.mean, d)} (sd ${fmt(s.stdev, d)}, ${fmt(s.min, d)} to ${fmt(s.max, d)}, n=${s.n})`
    : "n/a";

export const noiseNote =
  "Differences are called real only when they exceed the larger of the min-max spread between runs, twice the standard error and 1% of the baseline. Scene, temperature, background load and driver state all move FPS between runs; this report states what was measured on this PC and does not predict other games or PCs.";

export function benchMarkdown(report: BenchReport): string {
  const r = compareBench(report.runs);
  const lines = [
    `# Frameforge benchmark: ${report.gameName}`,
    "",
    `Saved ${report.at}. Runs with Game Mode off: ${r.offRuns.length}. Runs with Game Mode on: ${r.onRuns.length}.`,
    "",
    `**${r.headline}**`,
    "",
    ...r.warnings.map((w) => `> ${w}`),
    "",
    "| Metric | Game Mode off | Game Mode on | Difference | Verdict |",
    "| --- | --- | --- | --- | --- |",
    ...r.rows.map((row) => {
      const d = row.metric.digits;
      const diff =
        row.delta === null
          ? "n/a"
          : `${row.delta >= 0 ? "+" : ""}${fmt(row.delta, d)} ${row.metric.unit}${row.deltaPercent === null ? "" : ` (${row.deltaPercent >= 0 ? "+" : ""}${fmt(row.deltaPercent, 1)}%)`}`;
      return `| ${row.metric.label} | ${cell(row.off, d)} | ${cell(row.on, d)} | ${diff} | ${verdictLabel(row.verdict)} |`;
    }),
    "",
    "Cells show mean (standard deviation, min to max, number of runs).",
    "",
    `Noise note: ${noiseNote}`,
    "",
  ];
  return lines.join("\n");
}

export function benchCsv(report: BenchReport): string {
  const head = [
    "run",
    "at",
    "game_mode",
    "seconds",
    "avg_fps",
    "low1_fps",
    "low01_fps",
    "p99_ms",
    "stutters",
    "cpu_percent",
    "gpu_percent",
    "included",
  ];
  const q = (v: unknown) =>
    v === null || v === undefined
      ? ""
      : /[",\n]/.test(String(v))
        ? `"${String(v).replace(/"/g, '""')}"`
        : String(v);
  const rows = report.runs.map((run, i) =>
    [
      i + 1,
      run.at,
      run.boost,
      run.durationSeconds,
      run.avgFps,
      run.low1Fps,
      run.low01Fps,
      run.p99Ms,
      run.stutters,
      run.cpuPercent,
      run.gpuPercent,
      usable(run) ?? "yes",
    ]
      .map(q)
      .join(","),
  );
  return [head.join(","), ...rows, ""].join("\n");
}
