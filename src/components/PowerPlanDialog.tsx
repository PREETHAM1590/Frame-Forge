import { Button, Modal } from "./ui";
import type { ViewProps } from "../types";

/** Consent dialog for creating Frameforge's copy of Windows' High performance plan, wherever the plan turns out to be missing. */
export function PowerPlanDialog({
  run,
  pending,
  onClose,
  onDone,
}: {
  run: ViewProps["run"];
  pending: boolean;
  onClose: () => void;
  /** Called after Windows created the plan, so the caller can refresh what it showed as unavailable. */
  onDone?: () => void;
}) {
  return (
    <Modal
      title="Create a High performance power plan?"
      description="Windows has no High performance plan on this PC, so the High performance power plan optimization and the power-plan step of a boost are unavailable."
      onClose={onClose}
    >
      <p className="muted">
        Frameforge copies Windows' built-in High performance plan into a new
        plan named “Frameforge High performance”. Your current plan stays
        active. Applying the optimization (or starting a boost) switches to the
        new plan, and rolling back (or the end of the boost) switches back. High
        performance uses more power and can run your PC warmer. You can remove
        the plan in Game Mode at any time; your other plans are never changed.
        Some laptops (Modern Standby) do not allow this; then Windows says so
        and nothing is created.
      </p>
      <div className="dialog-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={pending}
          onClick={async () => {
            const result = await run("boostPowerPlan", {
              action: "create",
              confirmed: true,
            });
            onClose();
            if (result) onDone?.();
          }}
        >
          Create plan
        </Button>
      </div>
    </Modal>
  );
}
