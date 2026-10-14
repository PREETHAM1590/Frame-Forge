import { Check, LoaderCircle } from "lucide-react";
import type { ApplyPhase } from "./useApplyFlow";

/** Shown while the apply step runs: an animated bar plus the phases that are part of this run. */
export function ApplyProgress({
  phase,
  withPoint,
}: {
  phase: ApplyPhase;
  withPoint: boolean;
}) {
  const rows: { key: ApplyPhase; label: string }[] = [
    ...(withPoint
      ? [
          { key: "point" as const, label: "Creating a Windows restore point" },
          { key: "recheck" as const, label: "Re-checking the Windows values" },
        ]
      : []),
    {
      key: "apply" as const,
      label: "Writing the settings and reading them back",
    },
  ];
  const at = rows.findIndex((r) => r.key === phase);
  return (
    <div className="af-progress" role="status" aria-live="polite">
      <span className="af-kicker">Applying</span>
      <div className="af-bar" aria-hidden="true">
        <span />
      </div>
      <ol className="af-phases">
        {rows.map((row, i) => {
          const state = i < at ? "done" : i === at ? "active" : "queued";
          return (
            <li key={row.key} className={state}>
              {state === "done" ? (
                <Check size={14} aria-hidden="true" />
              ) : state === "active" ? (
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
              ) : (
                <span className="af-dot" aria-hidden="true" />
              )}
              {row.label}
              <span className="sr-only">
                {state === "done"
                  ? " done"
                  : state === "active"
                    ? " in progress"
                    : " waiting"}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="muted">
        Windows may show an administrator prompt. You can cancel until the
        settings are written.
      </p>
    </div>
  );
}
