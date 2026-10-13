import { useLayoutEffect, useRef } from "react";
const animated =
  import.meta.env.MODE !== "test" &&
  typeof window !== "undefined" &&
  !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/**
 * Tweens a number to its new value. The DOM always holds the final text first, so
 * assistive tech and tests see the real value; the tween only rewrites the text node.
 */
export function CountUp({
  value,
  format = (n) => String(Math.round(n)),
  duration = 600,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    if (!node) return;
    const from = shown.current ?? 0;
    shown.current = value;
    if (!animated || from === value) return;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      node.nodeValue = format(from + (value - from) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      node.nodeValue = format(value);
    };
  }, [value, format, duration]);
  return (
    <span ref={ref} className="num">
      {format(value)}
    </span>
  );
}
