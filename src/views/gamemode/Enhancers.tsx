import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { Badge, Button, Toggle } from "../../components/ui";
import type {
  BoosterConfig,
  MechanismId,
  TimerStatus,
} from "../../../shared/contracts";
import type { ViewProps } from "../../types";
import type { Capability, Status } from "./model";
import { labels } from "./model";

/** Machine-level features and the auto-boost switch: what Game Mode can use on this PC. */
export function Enhancers({
  config,
  status,
  caps,
  cap,
  timer,
  unavailable,
  pending,
  timerPending,
  session,
  run,
  save,
  setStatus,
  onCreatePlan,
  onTimerDialog,
}: {
  config: BoosterConfig;
  status: Status | null;
  caps: Status["capabilities"] | undefined;
  cap: (id: MechanismId) => Capability | undefined;
  timer: TimerStatus | undefined;
  unavailable: string;
  pending: boolean;
  timerPending?: boolean;
  session: boolean;
  run: ViewProps["run"];
  save: (next: Partial<BoosterConfig>) => Promise<unknown>;
  setStatus: (s: Status) => void;
  onCreatePlan: () => void;
  onTimerDialog: (d: "enable" | "restore") => void;
}) {
  return (
    <div className="gm-enhancers" aria-label="Game enhancers">
      <ul className="mechanism-list">
        <li>
          <span>{labels.powerPlan} on this PC</span>
          <Badge tone={cap("powerPlan")?.available ? "lime" : "amber"}>
            {cap("powerPlan")?.available ? "available" : "unavailable"}
          </Badge>
          <small className="muted">
            {cap("powerPlan")?.detail ?? "Checking…"}
            {status?.ownedPowerPlan
              ? " Frameforge created this plan with your consent."
              : ""}
          </small>
          {!unavailable &&
            caps &&
            !cap("powerPlan")?.available &&
            !status?.ownedPowerPlan && (
              <Button
                disabled={pending || session}
                title={
                  session
                    ? "Stop the boost session first."
                    : "Create a copy of Windows' High performance plan for boost sessions."
                }
                onClick={onCreatePlan}
              >
                <Plus size={17} /> Create High performance plan…
              </Button>
            )}
          {!unavailable && status?.ownedPowerPlan && (
            <Button
              disabled={pending || session}
              title={
                session
                  ? "Stop the boost session first."
                  : "Remove the plan Frameforge created. Your other plans are untouched."
              }
              onClick={async () => {
                const result = await run("boostPowerPlan", {
                  action: "remove",
                  confirmed: true,
                });
                if (result) setStatus(result);
              }}
            >
              <Trash2 size={17} /> Remove Frameforge plan
            </Button>
          )}
        </li>
        <li>
          <span>{labels.timerResolution} on this PC</span>
          {timer && timer.enabled && !timer.restartRequired ? (
            <Badge tone="neutral">
              {timer.ownedByFrameforge
                ? "on (set by Frameforge)"
                : "already on in Windows"}
            </Badge>
          ) : timer?.restartRequired ? (
            <Badge tone="amber">restart Windows to finish</Badge>
          ) : timer?.eligible ? (
            <Badge tone="amber">off in Windows</Badge>
          ) : (
            <Badge tone={cap("timerResolution")?.available ? "lime" : "amber"}>
              {cap("timerResolution")?.available ? "available" : "unsupported"}
            </Badge>
          )}
          <small className="muted">
            {cap("timerResolution")?.detail ?? "Checking…"}
            {timer &&
            !timer.eligible &&
            cap("timerResolution")?.available === false
              ? " There is nothing Frameforge can change for this on Windows 10: a timer request only reaches the program that made it. Windows 11 can do this."
              : ""}
          </small>
          {!unavailable &&
            timer?.eligible &&
            !timer.enabled &&
            !timer.ownedByFrameforge && (
              <Button
                disabled={pending || !!timerPending || session}
                title={
                  session
                    ? "Stop the boost session first."
                    : "Turn on Windows' system-wide timer setting (administrator approval and a restart)."
                }
                onClick={() => onTimerDialog("enable")}
              >
                Allow games to keep high timer resolution…
              </Button>
            )}
          {!unavailable && timer?.ownedByFrameforge && (
            <Button
              disabled={pending || !!timerPending || session}
              title={
                session
                  ? "Stop the boost session first."
                  : "Put back the value Frameforge saved before it turned the setting on."
              }
              onClick={() => onTimerDialog("restore")}
            >
              <RotateCcw size={17} /> Turn back off…
            </Button>
          )}
          {timerPending && (
            <small className="muted" role="status">
              Waiting for administrator approval. The rest of Frameforge stays
              usable.
            </small>
          )}
        </li>
        <li>
          <span>{labels.standbyPurge}</span>
          <Badge tone={cap("standbyPurge")?.available ? "neutral" : "amber"}>
            {cap("standbyPurge")?.available
              ? config.custom.standbyPurge
                ? "on in Custom"
                : "off (opt-in under Custom)"
              : "unavailable"}
          </Badge>
          <small className="muted">
            {cap("standbyPurge")?.detail ?? "Checking…"}
          </small>
        </li>
      </ul>
      <Toggle
        label="Auto-boost when a library game starts"
        description={
          unavailable ||
          `Checks every 5 seconds for a running library game and starts its mode.${status?.watching ? " Watching now." : ""}`
        }
        checked={config.autoBoost}
        disabled={pending || !!unavailable}
        onChange={(v) => void save({ autoBoost: v })}
      />
    </div>
  );
}
