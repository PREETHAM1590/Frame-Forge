import * as Switch from "@radix-ui/react-switch";
import { ArrowRight, Info, Search } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode, ButtonHTMLAttributes, CSSProperties } from "react";
export type Tone = "neutral" | "lime" | "cyan" | "amber" | "red";
export function Button({
  children,
  className = "",
  variant = "secondary",
  block = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  block?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button ${variant} ${block ? "block" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
/** Status tag: the text says the state, the tone and the glyph shape repeat it. */
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
/** One tone per journal/session status, shared by every list. */
export function statusTone(status: string): Tone {
  if (status === "success" || status === "active") return "lime";
  if (status === "failed" || status === "recovery-needed") return "red";
  if (status === "running" || status === "preparing" || status === "restoring")
    return "amber";
  if (status === "rolled-back") return "cyan";
  return "neutral";
}
export function LinkButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="text-button" onClick={onClick}>
      {children}
      <ArrowRight size={14} />
    </button>
  );
}
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="setting-row">
      <div>
        <label htmlFor={label}>{label}</label>
        <p className="muted">{description}</p>
      </div>
      <Switch.Root
        id={label}
        className="switch"
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      >
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
    </div>
  );
}
/** Info button whose text shows on hover and keyboard focus (no hover-only content). */
export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  // Escape hides the text until the pointer or focus comes back.
  const [hidden, setHidden] = useState(false);
  return (
    <span
      className="infotip"
      data-hidden={hidden || undefined}
      onKeyDown={(e) => e.key === "Escape" && setHidden(true)}
      onMouseEnter={() => setHidden(false)}
      onMouseLeave={() => setHidden(false)}
      onBlur={() => setHidden(false)}
    >
      <button
        type="button"
        className="infotip-btn"
        aria-label={`About ${label}`}
        aria-describedby={id}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      <span role="tooltip" id={id} className="infotip-body">
        {children}
      </span>
    </span>
  );
}
/** Native range input (keyboard and screen reader support for free), styled by tokens. */
export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  leftLabel,
  rightLabel,
  valueText,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  leftLabel?: string;
  rightLabel?: string;
  valueText?: string;
  disabled?: boolean;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      {(leftLabel || rightLabel) && (
        <div className="slider-ends" aria-hidden="true">
          <span>{leftLabel}</span>
          <span>{rightLabel}</span>
        </div>
      )}
      <input
        type="range"
        aria-label={label}
        aria-valuetext={valueText}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ "--pct": `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
/** A radio group drawn as joined buttons. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Labelled search input with the shared look. */
export function SearchField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="search">
      <Search size={16} aria-hidden />
      <input
        placeholder={placeholder ?? label}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
/** Filter chips: toggle buttons (aria-pressed), one active at a time. */
export function Chips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; count?: number }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`chip ${value === o.id ? "active" : ""}`}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
          {o.count !== undefined && (
            <span className="chip-count">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
