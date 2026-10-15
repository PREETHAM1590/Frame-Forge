import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
/**
 * Native details/summary: keyboard and screen reader support for free. Advanced options live in these.
 * `heading` makes the title a real h2 (used by Settings groups, which have an icon too).
 */
export function Disclosure({
  title,
  hint,
  icon,
  heading = false,
  children,
  defaultOpen = false,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  heading?: boolean;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const label = (
    <>
      {icon}
      {title}
    </>
  );
  return (
    <details
      className={`disclosure ${heading ? "group" : ""}`}
      open={defaultOpen || undefined}
    >
      <summary>
        <ChevronRight size={16} className="disclosure-chevron" />
        {heading ? <h2>{label}</h2> : <span>{title}</span>}
        {hint && <span className="label">{hint}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
