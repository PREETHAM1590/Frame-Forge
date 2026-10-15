import { forwardRef } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { catalogue } from "../../../shared/catalogue";
import type { Activity } from "../../../shared/contracts";
import type { RowOutcome } from "./useApplyFlow";
import { Badge, Button } from "../../components/ui";
import type { ReactNode } from "react";

type Tone = "lime" | "amber" | "red" | "cyan";
export interface Outcome {
  key:
    | "applied"
    | "unchanged"
    | "partial"
    | "reverted"
    | "failed"
    | "cancelled"
    | "recovery";
  label: string;
  tone: Tone;
}
/** Maps the journal row (and whether preset items were skipped) to one clear state. */
export function outcomeOf(result: Activity, skippedCount: number): Outcome {
  if (result.status === "success" && result.message.startsWith("Already set"))
    return { key: "unchanged", label: "Already set — no change", tone: "cyan" };
  if (result.status === "success")
    return skippedCount > 0
      ? { key: "partial", label: "Partially applied", tone: "amber" }
      : { key: "applied", label: "Applied", tone: "lime" };
  if (result.status === "recovery-needed")
    return { key: "recovery", label: "Recovery needed", tone: "red" };
  if (result.status === "cancelled" && result.message.startsWith("Not applied"))
    return { key: "cancelled", label: "Not applied", tone: "amber" };
  if (result.status === "cancelled")
    return { key: "cancelled", label: "Cancelled", tone: "amber" };
  if (result.message.startsWith("Windows reverted"))
    return {
      key: "reverted",
      label: "Windows reverted the change",
      tone: "cyan",
    };
  return { key: "failed", label: "Failed", tone: "red" };
}
const icons = {
  applied: CheckCircle2,
  unchanged: CheckCircle2,
  partial: AlertTriangle,
  reverted: RotateCcw,
  failed: XCircle,
  cancelled: AlertTriangle,
  recovery: XCircle,
};

/** Final step. The heading takes focus when it appears so screen readers announce the outcome. */
export const ResultStep = forwardRef<
  HTMLHeadingElement,
  {
    result: Activity;
    skippedCount: number;
    rows?: RowOutcome[];
    notes?: string[];
    skippedNotice: ReactNode;
    onActivity: () => void;
    onClose: () => void;
  }
>(function ResultStep(
  {
    result,
    skippedCount,
    rows = [],
    notes = [],
    skippedNotice,
    onActivity,
    onClose,
  },
  ref,
) {
  const outcome = outcomeOf(result, skippedCount);
  const Icon = icons[outcome.key];
  return (
    <div className={`operation-result af-result ${outcome.key}`}>
      <div className="af-result-head">
        <Icon size={22} aria-hidden="true" />
        <h3 ref={ref} tabIndex={-1}>
          {outcome.label}
        </h3>
        <Badge tone={outcome.tone}>{result.status}</Badge>
      </div>
      <p>{result.message}</p>
      {rows.length > 0 && (
        <ul className="af-rows" aria-label="Result for each switch">
          {rows.map((r) => (
            <li key={`${r.id}-${r.want}`}>
              <strong>{catalogue.find((o) => o.id === r.id)?.name}</strong>
              {": "}
              {r.got === r.want
                ? `${r.want === "on" ? "On" : "Off"} (verified)`
                : r.got === "unknown"
                  ? `Asked to turn ${r.want}; Windows cannot be read here. See Activity.`
                  : `Still ${r.got}: it did not turn ${r.want}.`}
            </li>
          ))}
        </ul>
      )}
      {notes.map((n) => (
        <p className="notice" key={n} role="alert">
          <AlertTriangle size={17} />
          {n}
        </p>
      ))}
      <code className="setting-path">{result.id}</code>
      {skippedNotice}
      <div className="dialog-actions">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={onActivity}>
          Open activity
          <ChevronRight size={16} />
        </Button>
      </div>
    </div>
  );
});
