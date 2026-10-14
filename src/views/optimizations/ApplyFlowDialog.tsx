import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { catalogue } from "../../../shared/catalogue";
import type { Page } from "../../types";
import { Button, Busy, Modal } from "../../components/ui";
import { PowerPlanDialog } from "../../components/PowerPlanDialog";
import { ApplyProgress } from "./ApplyProgress";
import { ResultStep } from "./ResultStep";
import { ReviewStep, restoreWait, securityName } from "./ReviewStep";
import { StepIndicator } from "./StepIndicator";
import type { ApplyFlow, RunFn } from "./useApplyFlow";

/**
 * Preview, confirm, apply and result for one or more optimizations. Focus stays inside the dialog (Radix) and is
 * returned to the opener on close; the result heading takes focus when the outcome arrives.
 */
export function ApplyFlowDialog({
  flow,
  run,
  pending,
  restoreRequests,
  navigate,
}: {
  flow: ApplyFlow;
  run: RunFn;
  pending: boolean;
  restoreRequests: number;
  navigate: (page: Page) => void;
}) {
  const { selection, preview, result, applying } = flow;
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const hasResult = !!result;
  useEffect(() => {
    if (hasResult) resultHeading.current?.focus();
  }, [hasResult]);
  const skippedNotice = flow.skipped.length ? (
    <p className="notice">
      <AlertTriangle size={17} />
      <span>
        Skipped — not available on this PC:{" "}
        {flow.skipped
          .map((id) => catalogue.find((o) => o.id === id)?.name)
          .join(", ")}
        . The other items in this selection are not affected.{" "}
        {flow.skipped.includes("power-plan") && (
          <Button disabled={pending} onClick={() => flow.setPlanDialog(true)}>
            Create High performance plan…
          </Button>
        )}
      </span>
    </p>
  ) : null;
  const step = result ? 3 : applying ? 2 : preview ? 1 : 0;
  const withPoint = flow.restoreOffer && flow.createPoint;
  const canApply =
    !!preview &&
    flow.confirmed &&
    (preview.security.length === 0 ||
      (flow.understood &&
        flow.typedName.trim().toLowerCase() ===
          securityName(flow).toLowerCase())) &&
    !applying &&
    !flow.previewLoading &&
    restoreRequests === 0;
  return (
    <>
      {flow.planDialog && (
        <PowerPlanDialog
          run={run}
          pending={pending}
          onClose={() => flow.setPlanDialog(false)}
          onDone={flow.planCreated}
        />
      )}
      {selection && (
        <Modal
          title={
            result
              ? "Operation result"
              : selection.length > 1
                ? "Review preset"
                : "Preview Windows preference"
          }
          description={
            result
              ? "The result below comes from the operation journal."
              : "Review the affected settings. Applying creates an app backup and saves the Windows values for rollback."
          }
          locked={applying || flow.previewLoading}
          onClose={flow.close}
        >
          <StepIndicator step={step} />
          {result ? (
            <ResultStep
              ref={resultHeading}
              result={result}
              skippedCount={flow.skipped.length}
              skippedNotice={skippedNotice}
              onClose={flow.close}
              onActivity={() => {
                flow.close();
                navigate("Activity");
              }}
            />
          ) : (
            <>
              {applying && (
                <ApplyProgress phase={flow.phase} withPoint={withPoint} />
              )}
              {/* Stays mounted (hidden) while applying so entered values survive a failed attempt. */}
              <div hidden={applying}>
                <ReviewStep
                  flow={flow}
                  restoreRequests={restoreRequests}
                  skippedNotice={skippedNotice}
                >
                  {flow.stale && (
                    <p className="notice" role="status">
                      <AlertTriangle size={17} />
                      The last attempt did not finish, so nothing is assumed.
                      Your confirmation is kept; Confirm &amp; apply checks
                      Windows again first.
                    </p>
                  )}
                  {flow.noPoint && (
                    <div className="notice" role="alert">
                      <AlertTriangle size={18} />
                      <div>
                        <strong>Apply without a restore point?</strong>
                        <p>{flow.noPoint}</p>
                        <div className="dialog-actions">
                          <Button onClick={flow.close}>Don&apos;t apply</Button>
                          <Button
                            variant="danger"
                            disabled={applying || restoreRequests > 0}
                            title={
                              restoreRequests > 0 ? restoreWait : undefined
                            }
                            onClick={() => void flow.apply(false, true)}
                          >
                            Apply without a restore point
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </ReviewStep>
              </div>
              <div className="dialog-actions">
                {applying ? (
                  <Button onClick={() => void run("cancel", {})}>
                    Cancel operation
                  </Button>
                ) : (
                  <Button onClick={flow.close}>Close</Button>
                )}
                <Button
                  variant="primary"
                  disabled={!canApply}
                  title={restoreRequests > 0 ? restoreWait : undefined}
                  onClick={() => void flow.apply(withPoint, false)}
                >
                  {applying ? (
                    <Busy label="Applying and verifying" />
                  ) : (
                    "Confirm & apply"
                  )}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
