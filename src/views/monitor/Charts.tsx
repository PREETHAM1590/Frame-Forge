import { historyLength } from "../../useMonitor";
const W = 300;
const H = 64;
/** Path data for a line over the last `slots` readings, newest at the right; missing readings leave the left edge empty. */
export function linePoints(
  values: readonly number[],
  max: number,
  slots = historyLength,
): [number, number][] {
  const step = W / (slots - 1);
  const offset = slots - values.length;
  return values.map((v, i) => [
    +((offset + i) * step).toFixed(1),
    +(H - Math.max(0, Math.min(1, v / max)) * (H - 2) - 1).toFixed(1),
  ]);
}
const d = (points: [number, number][]) =>
  points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
/**
 * A small area chart. Each new reading slides the drawing left by one step (CSS; off when the person asked for reduced motion).
 * `values` is oldest first. The text label carries the numbers, so the drawing itself is decorative.
 */
export function AreaChart({
  values,
  max = 100,
  label,
  tone = "primary",
  slots = historyLength,
  tick,
}: {
  values: readonly number[];
  max?: number;
  label: string;
  tone?: "primary" | "caution" | "error" | "info";
  slots?: number;
  /** Changes with every reading; restarts the slide even when the value did not change. */
  tick?: string | number;
}) {
  const shown = values.slice(-slots);
  const points = linePoints(shown, max, slots);
  const step = W / (slots - 1);
  return (
    <svg
      className={`area-chart ${tone}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <line className="grid" x1="0" x2={W} y1={H / 2} y2={H / 2} />
      {points.length > 1 && (
        <g
          // A new key restarts the slide for every reading.
          key={tick ?? shown.length + ":" + (shown.at(-1) ?? 0)}
          className="slide"
          style={{ ["--step" as string]: `${step}px` }}
        >
          <path
            className="area"
            d={`${d(points)} L${points.at(-1)![0]} ${H} L${points[0][0]} ${H} Z`}
          />
          <path className="line" d={d(points)} />
        </g>
      )}
    </svg>
  );
}
