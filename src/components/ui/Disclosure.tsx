import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
/** Native details/summary: keyboard and screen reader support for free. Advanced options live in these. */
export function Disclosure({
  title,
  hint,
  children,
  defaultOpen = false,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="disclosure" open={defaultOpen || undefined}>
      <summary>
        <ChevronRight size={16} className="disclosure-chevron" />
        <span>{title}</span>
        {hint && <span className="label">{hint}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
