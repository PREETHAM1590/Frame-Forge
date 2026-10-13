import type { ReactNode, CSSProperties, HTMLAttributes } from "react";
import { CountUp } from "./CountUp";
import { Badge } from "./controls";
import type { Tone } from "./controls";
type PanelTone = "default" | "alt" | "accent" | "warn" | "danger";
export function Panel({
  tone = "default",
  flush = false,
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  tone?: PanelTone;
  flush?: boolean;
}) {
  return (
    <section
      {...rest}
      className={`panel ${tone === "default" ? "" : tone} ${flush ? "flush" : ""} ${className}`}
    >
      {children}
    </section>
  );
}
/** Cells share their borders: no gutter, the grid background is the rule between them. */
export function CellGrid({
  columns,
  className = "",
  children,
  stagger = false,
  style,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  columns: string;
  stagger?: boolean;
}) {
  return (
    <div
      {...rest}
      className={`cells ${stagger ? "stagger" : ""} ${className}`}
      style={{ gridTemplateColumns: columns, ...style }}
    >
      {children}
    </div>
  );
}
export function Meter({
  value,
  label,
  tone = "primary",
  thick = false,
}: {
  /** 0 to 100 */
  value: number;
  label: string;
  tone?: "primary" | "caution" | "error";
  thick?: boolean;
}) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`meter ${tone === "primary" ? "" : tone} ${thick ? "thick" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
    >
      <div className="meter-fill" style={{ "--v": v / 100 } as CSSProperties} />
    </div>
  );
}
export function StatCell({
  label,
  value,
  count,
  format,
  unit,
  hint,
  status,
  meter,
  large = false,
  className = "",
}: {
  label: string;
  /** Text value; ignored when `count` is given. */
  value?: ReactNode;
  count?: number;
  format?: (n: number) => string;
  unit?: string;
  hint?: ReactNode;
  status?: { text: string; tone?: Tone };
  meter?: {
    value: number;
    label: string;
    tone?: "primary" | "caution" | "error";
  };
  large?: boolean;
  className?: string;
}) {
  return (
    <div className={`stat ${className}`}>
      <div className="stat-head">
        <span className="label">{label}</span>
        {status && <Badge tone={status.tone}>{status.text}</Badge>}
      </div>
      <div className={`stat-value ${large ? "xl" : ""}`}>
        {count !== undefined ? (
          <CountUp value={count} format={format} />
        ) : (
          value
        )}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {hint && <div className="stat-hint">{hint}</div>}
      {meter && <Meter {...meter} />}
    </div>
  );
}
export function SectionHeader({
  title,
  icon,
  index,
  aside,
  level = 2,
}: {
  title: string;
  icon?: ReactNode;
  index?: string;
  aside?: ReactNode;
  level?: 2 | 3;
}) {
  const H = `h${level}` as "h2" | "h3";
  return (
    <div className="section-header">
      <H>
        {icon}
        {index && <span className="index">{index}</span>}
        {title}
      </H>
      {aside}
    </div>
  );
}
