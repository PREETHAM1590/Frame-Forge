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
 * A small area chart, redrawn only when a sample arrives. Continuous sliding is costly in software rendering.
 * `values` is oldest first. The text label carries the numbers, so the drawing itself is decorative.
 */
export function AreaChart({
  values,
  max = 100,
  label,
  tone = "primary",
  slots = historyLength,
}: {
  values: readonly number[];
  max?: number;
  label: string;
  tone?: "primary" | "caution" | "error" | "info";
  slots?: number;
}) {
  const shown = values.slice(-slots);
  const points = linePoints(shown, max, slots);
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
        <g>
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
