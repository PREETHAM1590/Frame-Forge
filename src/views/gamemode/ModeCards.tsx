import { Badge, Button, Disclosure, Meter } from "../../components/ui";
import type {
  BoostMode,
  BoosterConfig,
  MechanismId,
  TimerStatus,
} from "../../../shared/contracts";
import { effectiveMechanisms } from "../../../shared/contracts";
import type { Capability, Status } from "./model";
import { enabled, intensity, labels, modes, onThisPc, tagline } from "./model";

/** What each mode does on this PC right now: effects first, then what is not applied and why. */
export function ModeCards({
  config,
  caps,
  cap,
  timer,
  pending,
  onSelect,
}: {
  config: BoosterConfig;
  caps: Status["capabilities"] | undefined;
  cap: (id: MechanismId) => Capability | undefined;
  timer: TimerStatus | undefined;
  pending: boolean;
  onSelect: (mode: BoostMode) => void;
}) {
  return (
    <div className="gm-cards stagger">
      {modes
        .filter((m) => m.id !== "off")
        .map((m) => {
          const list = enabled(effectiveMechanisms(config, m.id));
          const plans = list.map((entry) => ({
            entry,
            plan: onThisPc(entry, cap(entry.id), config.background, {
              preset: m.id !== "custom" && config.overrides.smartCores !== true,
              threadDirector: !!caps?.topology?.threadDirector,
              timer,
            }),
          }));
          const effects = plans.filter((p) => p.plan.tone === "lime");
          // Until this PC has been checked everything is "checking"; afterwards only real effects are listed as effects.
          const shown = caps ? effects : plans;
          const notApplied = caps
            ? plans.filter((p) => p.plan.tone !== "lime")
            : [];
          const selected = config.mode === m.id;
          if (m.id === "smart")
            return (
              <article
                key={m.id}
                className={`mode-card ${selected ? "selected" : ""}`}
                aria-label="Smart on this PC"
              >
                <header className="mode-card-head">
                  <div>
                    <h3>{m.label}</h3>
                    <p className="muted">{tagline[m.id]}</p>
                  </div>
                  {selected && <Badge tone="lime">selected</Badge>}
                </header>
                <ul className="mechanism-list">
                  <li>
                    <span>Watches the first minute, changes nothing</span>
                  </li>
                  <li>
                    <span>
                      CPU-bound: priority, core unparking, finer timer, easing
                      background apps
                    </span>
                  </li>
                  <li>
                    <span>
                      GPU-bound: GPU priority and a performance plan, plus
                      advice
                    </span>
                  </li>
                  <li>
                    <span>
                      Memory or heat limited: light changes and advice
                    </span>
                  </li>
                </ul>
                <footer className="mode-card-foot">
                  {!selected && (
                    <Button
                      disabled={pending}
                      onClick={() => onSelect(m.id)}
                      aria-label="Use Smart"
                    >
                      Use this mode
                    </Button>
                  )}
                </footer>
              </article>
            );
          const asksAdmin = list.some(
            (e) => e.id === "pauseServices" || e.id === "standbyPurge",
          );
          return (
            <article
              key={m.id}
              className={`mode-card ${selected ? "selected" : ""}`}
              aria-label={`${m.label} on this PC`}
            >
              <header className="mode-card-head">
                <div>
                  <h3>{m.label}</h3>
                  <p className="muted">{tagline[m.id]}</p>
                </div>
                {selected && <Badge tone="lime">selected</Badge>}
              </header>
              {intensity[m.id] >= 0 && (
                <Meter
                  label={`${m.label} intensity`}
                  value={(intensity[m.id]! / 3) * 100}
                  thick
                />
              )}
              <p className="muted gm-count">
                {caps
                  ? `Changes ${effects.length} of ${list.length} on this PC.`
                  : "Checking this PC…"}
              </p>
              {m.id !== "custom" &&
                Object.keys(config.overrides).length > 0 && (
                  <p className="muted gm-count">
                    Includes your {Object.keys(config.overrides).length}{" "}
                    enhancer change(s).
                  </p>
                )}
              <ul className="mechanism-list">
                {shown.map(({ entry, plan }) => (
                  <li key={entry.id}>
                    <span>{labels[entry.id]}</span>
                    <Badge tone={plan.tone}>{plan.label}</Badge>
                    {plan.reason && (
                      <small className="muted">{plan.reason}</small>
                    )}
                  </li>
                ))}
                {!list.length && (
                  <li className="muted">Nothing selected yet.</li>
                )}
              </ul>
              {notApplied.length > 0 && (
                <Disclosure title={`${notApplied.length} not applied — why?`}>
                  <ul
                    className="mechanism-list"
                    aria-label={`${m.label}: not applied on this PC`}
                  >
                    {notApplied.map(({ entry, plan }) => (
                      <li key={entry.id}>
                        <span>{labels[entry.id]}</span>
                        <Badge tone={plan.tone}>{plan.label}</Badge>
                        {plan.reason && (
                          <small className="muted">{plan.reason}</small>
                        )}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
              <footer className="mode-card-foot">
                {asksAdmin && <Badge tone="amber">asks for admin</Badge>}
                {!selected && (
                  <Button
                    disabled={pending}
                    onClick={() => onSelect(m.id)}
                    aria-label={`Use ${m.label}`}
                  >
                    Use this mode
                  </Button>
                )}
              </footer>
            </article>
          );
        })}
    </div>
  );
}
