import { AlertTriangle, ChevronRight } from "lucide-react";
import { catalogue, restartText } from "../../../shared/catalogue";
import { Badge, Busy, formatTime } from "../../components/ui";
import type { ReactNode } from "react";
import type { ApplyFlow } from "./useApplyFlow";

export const restoreWait =
  "A System Restore request is waiting on Windows. Wait for it to finish before changing Windows settings.";
/** Name the person must type for a security trade-off (compared case-insensitively). */
export const securityName = (flow: ApplyFlow) =>
  flow.preview && flow.preview.security.length > 0
    ? catalogue.find((o) => o.id === flow.preview!.security[0])!.name
    : "";

/** Rows that would actually write something; already-set rows are shown but not counted. */
export const changeCount = (preview: { changes: { alreadySet: boolean }[] }) =>
  preview.changes.filter((c) => !c.alreadySet).length;

/** Steps 1 and 2: what will change, then the safeguards that must be accepted before applying. */
export function ReviewStep({
  flow,
  restoreRequests,
  skippedNotice,
  children,
}: {
  flow: ApplyFlow;
  restoreRequests: number;
  skippedNotice: ReactNode;
  /** Rendered after the preview text: the restore-point failure prompt. */
  children?: ReactNode;
}) {
  const { preview, selection, skipped, applying } = flow;
  return (
    <>
      <div className="preview-items">
        {selection!.map((id) => {
          const item = catalogue.find((o) => o.id === id)!;
          return (
            <div key={id}>
              <h3>{item.name}</h3>
              {skipped.includes(id) ? (
                <Badge tone="amber">Skipped — not available on this PC</Badge>
              ) : (
                <Badge tone={item.risk === "Low" ? "lime" : "amber"}>
                  {item.risk} risk
                </Badge>
              )}
              <p className="muted">{item.description}</p>
            </div>
          );
        })}
      </div>
      {skippedNotice}
      {flow.previewLoading ? (
        <Busy label="Checking prerequisites and current values" />
      ) : preview ? (
        <>
          <span className="af-kicker">
            {changeCount(preview)} change
            {changeCount(preview) === 1 ? "" : "s"}
          </span>
          <div className="change-list">
            {preview.changes.map((change) => (
              <div key={change.setting}>
                <code>{change.setting}</code>
                <span>
                  <span className="af-before">{change.before}</span>
                  <ChevronRight size={14} />
                  <strong>{change.after}</strong>
                  {change.alreadySet && <Badge tone="lime">Already set</Badge>}
                </span>
              </div>
            ))}
          </div>
          {preview.warnings.map((w) => (
            <p className="notice" key={w}>
              <AlertTriangle size={17} />
              {w}
            </p>
          ))}
          <p className="muted">
            Preview expires {formatTime(preview.expiresAt)}.{" "}
            {flow.restoreOffer && flow.createPoint
              ? "Creating the restore point shows a Windows administrator prompt. "
              : ""}
            {preview.admin
              ? "Applying shows a Windows administrator prompt for the machine settings above. "
              : "No administrator prompt for these settings. "}
            {restartText[preview.restart]}
          </p>
          {flow.restoreOffer && (
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={flow.createPoint}
                disabled={applying}
                onChange={(e) => flow.setCreatePoint(e.target.checked)}
              />
              Create a Windows restore point first
            </label>
          )}
          {flow.restoreOffer && flow.createPoint && restoreRequests > 0 && (
            <p className="muted" role="status">
              Waiting for another Windows restore request to finish (Restore &
              backups). Untick the restore point to apply now.
            </p>
          )}
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={flow.confirmed}
              disabled={applying}
              onChange={(e) => flow.setConfirmed(e.target.checked)}
            />
            I reviewed the changes and confirm applying them.
          </label>
          {preview.security.length > 0 && (
            <div className="security-confirm" role="group">
              <p className="notice" role="alert">
                <AlertTriangle size={17} />
                {preview.security
                  .map((id) => catalogue.find((o) => o.id === id)!)
                  .map((o) => o.consequence)
                  .join(" ")}
              </p>
              <label className="confirm-check">
                <input
                  type="checkbox"
                  checked={flow.understood}
                  disabled={applying}
                  onChange={(e) => flow.setUnderstood(e.target.checked)}
                />
                I understand this lowers my PC&apos;s security.
              </label>
              <label className="field">
                Type &quot;{securityName(flow)}&quot; to confirm
                <input
                  value={flow.typedName}
                  disabled={applying}
                  autoComplete="off"
                  onChange={(e) => flow.setTypedName(e.target.value)}
                />
              </label>
            </div>
          )}
        </>
      ) : (
        <div className="notice" role={flow.previewError ? "alert" : undefined}>
          <AlertTriangle size={18} />
          {flow.previewError
            ? `Preview not available: ${flow.previewError} Nothing was changed.`
            : "These Windows changes are unavailable on this installation. This is a review only. Launch the desktop app with its published Windows helper to check prerequisites."}
        </div>
      )}
      {children}
    </>
  );
}
