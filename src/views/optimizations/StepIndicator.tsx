import { Check } from "lucide-react";

export const applySteps = ["Preview", "Confirm", "Apply", "Result"] as const;

/** Four-step progress marker for the apply flow; the current step is exposed with aria-current. */
export function StepIndicator({ step }: { step: number }) {
  return (
    <ol className="af-steps" aria-label="Apply progress">
      {applySteps.map((label, i) => {
        const state = i < step ? "done" : i === step ? "current" : "todo";
        return (
          <li
            key={label}
            className={`af-step ${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="af-step-mark" aria-hidden="true">
              {state === "done" ? <Check size={12} /> : `0${i + 1}`}
            </span>
            <span className="af-step-label">{label}</span>
            {state === "done" && <span className="sr-only"> (done)</span>}
          </li>
        );
      })}
    </ol>
  );
}
