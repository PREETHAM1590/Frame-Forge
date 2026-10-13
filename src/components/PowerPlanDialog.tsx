import { useEffect, useState } from "react";
import { Badge, Button, Modal } from "./ui";
import type { PowerPlanEntry } from "../../shared/contracts";
import type { ViewProps } from "../types";

/** Consent dialog for creating Frameforge's copy of Windows' High performance plan, or adopting/removing same-named plans already on the PC. */
export function PowerPlanDialog({
  run,
  pending,
  onClose,
  onDone,
}: {
  run: ViewProps["run"];
  pending: boolean;
  onClose: () => void;
  /** Called after Windows created or adopted the plan, so the caller can refresh what it showed as unavailable. */
  onDone?: () => void;
}) {
  const [plans, setPlans] = useState<PowerPlanEntry[] | null>(null);
  const [owned, setOwned] = useState(false);
  useEffect(() => {
    let live = true;
    void run("boostPowerPlan", { action: "list", confirmed: true }).then(
      (r) => {
        if (!live) return;
        setPlans(r?.existingPlans ?? []);
        setOwned(r?.ownedPowerPlan ?? false);
      },
    );
    return () => {
      live = false;
    };
    // Once per opening of the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = async (
    action: "adopt" | "removeDuplicate",
    plan: PowerPlanEntry,
  ) => {
    const r = await run("boostPowerPlan", {
      action,
      guid: plan.guid,
      confirmed: true,
    });
    if (!r) return;
    setPlans(r.existingPlans);
    setOwned(r.ownedPowerPlan);
    if (action === "adopt") onDone?.();
  };
  const found = plans ?? [];
  const short = (guid: string) => guid.slice(0, 8);

  if (plans && found.length > 0)
    return (
      <Modal
        title={
          owned
            ? "Duplicate Frameforge power plans"
            : "A Frameforge power plan already exists"
        }
        description={
          owned
            ? "Windows has more plans with the same name. You can remove the ones Frameforge does not use."
            : "Windows already has a power plan named “Frameforge High performance” that Frameforge did not record, for example from an earlier install. Creating another would leave two."
        }
        onClose={onClose}
      >
        <p className="muted">
          {owned
            ? "Only plans with exactly this name that are not active can be removed. Windows' own plans and your other plans are never touched."
            : "Use the existing plan to let Frameforge switch to it during boosts and remove it later. Frameforge cannot fully verify its settings, so it is used as you left it. Removing a duplicate deletes only a plan with exactly this name that is not active."}
        </p>
        <ul className="mechanism-list">
          {found.map((plan) => (
            <li key={plan.guid}>
              <span>
                {plan.name} ({short(plan.guid)}…)
              </span>
              {plan.active && <Badge tone="amber">active</Badge>}
              {!owned && (
                <Button
                  variant="primary"
                  disabled={pending}
                  onClick={() => void act("adopt", plan)}
                >
                  Use existing Frameforge plan
                </Button>
              )}
              <Button
                disabled={pending || plan.active}
                title={
                  plan.active
                    ? "Switch to another power plan first."
                    : "Delete this duplicate plan."
                }
                onClick={() => void act("removeDuplicate", plan)}
              >
                Remove duplicate
              </Button>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <Button onClick={onClose}>{owned ? "Done" : "Cancel"}</Button>
        </div>
      </Modal>
    );

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
          disabled={pending || plans === null}
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
