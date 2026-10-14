import * as Switch from "@radix-ui/react-switch";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Disclosure,
  InfoTip,
  Toggle,
} from "../../components/ui";
import {
  effectiveMechanisms,
  modeMechanisms,
  type BoostMode,
  type BoosterConfig,
  type CustomMechanisms,
  type MechanismId,
  type TimerStatus,
} from "../../../shared/contracts";
import type { ViewProps } from "../../types";
import type { Capability, Status } from "./model";
import { unsupportedWhenUnavailable } from "./model";

type Row = {
  id: MechanismId;
  name: string;
  info: string;
  /** What turning it on needs from the user. */
  needs?: string;
  on: boolean;
  set: (on: boolean) => Partial<CustomMechanisms>;
  extra?: ReactNode;
};

/** The game enhancers: one toggle per mechanism, saved as overrides on top of the selected mode (Custom edits its own set). */
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
  const custom = config.mode === "custom";
  const off = config.mode === "off";
  const eff = effectiveMechanisms(config);
  const cpus = Math.min(caps?.logicalCpus ?? 0, 64);
  const overridden = Object.keys(config.overrides).length;
  const locked = pending || !!unavailable || off;
  // A sub-control of a row follows that mechanism's capability: it cannot be turned on where this PC can't do it.
  const blocked = (id: MechanismId, on: boolean) =>
    locked || (!!caps && cap(id)?.available === false && !on);
  // Windows 11 Thread Director builds leave smart cores off in presets; only an explicit choice turns it on there.
  const gated =
    !custom &&
    !!caps?.topology?.threadDirector &&
    config.overrides.smartCores !== true;
  const smartOn = eff.smartCores && !gated;
  // Presets keep only what differs from the mode; Custom edits its own set.
  const change = (patch: Partial<CustomMechanisms>) => {
    if (custom) return save({ custom: { ...config.custom, ...patch } });
    const base = modeMechanisms[config.mode as Exclude<BoostMode, "custom">];
    const next: Record<string, unknown> = { ...config.overrides, ...patch };
    // smartCores stays explicit: on Windows 11 the preset default does not apply, so "on" must be remembered as a choice.
    for (const key of Object.keys(next))
      if (
        key !== "smartCores" &&
        JSON.stringify(next[key]) ===
          JSON.stringify(base[key as keyof CustomMechanisms])
      )
        delete next[key];
    return save({ overrides: next as BoosterConfig["overrides"] });
  };
  const rows: Row[] = [
    {
      id: "powerPlan",
      name: "Power Plan",
      info: "Switches Windows to the High performance (or Ultimate) power plan while the game runs and switches back afterwards.",
      on: eff.powerPlan,
      set: (on) => ({ powerPlan: on }),
    },
    {
      id: "priority",
      name: "CPU Priority",
      info: "Raises the game's CPU priority class (Above normal or High, never Realtime) and puts it back afterwards. Skipped if the game already runs higher.",
      on: eff.priority !== "Normal",
      set: (on) => ({
        priority: on
          ? eff.priority !== "Normal"
            ? eff.priority
            : "High"
          : "Normal",
      }),
      extra: eff.priority !== "Normal" && (
        <label className="field">
          Priority level
          <select
            value={eff.priority}
            disabled={blocked("priority", false)}
            onChange={(e) =>
              void change({
                priority: e.target.value as CustomMechanisms["priority"],
              })
            }
          >
            <option value="AboveNormal">Above normal</option>
            <option value="High">High</option>
          </select>
        </label>
      ),
    },
    {
      id: "smartCores",
      name: "CPU Affinity",
      info: "Smart core targeting steers the game to the performance cores of a hybrid CPU with CPU sets. Windows 11 already does this in the presets, so there it is only on when you turn it on. Manual affinity limits the game to the CPUs you tick; some games run worse with fewer cores.",
      on: smartOn,
      set: (on) => ({ smartCores: on }),
      extra: (
        <Disclosure title="Manual affinity" hint="Advanced">
          <Toggle
            label="Limit game to selected CPUs"
            description={
              cpus
                ? "Test before relying on it."
                : "The CPU count is unknown until the desktop helper responds."
            }
            checked={eff.affinity !== null}
            disabled={blocked("affinity", eff.affinity !== null) || !cpus}
            onChange={(v) =>
              void change({
                affinity: v ? Array.from({ length: cpus }, (_, i) => i) : null,
              })
            }
          />
          {eff.affinity && cpus > 0 && (
            <fieldset className="cpu-grid">
              <legend>Logical CPUs</legend>
              {Array.from({ length: cpus }, (_, i) => (
                <label key={i}>
                  <input
                    type="checkbox"
                    checked={eff.affinity!.includes(i)}
                    disabled={blocked("affinity", false)}
                    onChange={(e) =>
                      void change({
                        affinity: e.target.checked
                          ? [...eff.affinity!, i].sort((a, b) => a - b)
                          : eff.affinity!.filter((c) => c !== i),
                      })
                    }
                  />
                  CPU {i}
                </label>
              ))}
            </fieldset>
          )}
        </Disclosure>
      ),
    },
    {
      id: "gpuPriority",
      name: "GPU Priority",
      info: "Raises the game's GPU scheduling priority to High (never Realtime) while it runs and restores the exact prior value afterwards. Applies to the game process only. Windows can refuse it for some games; that is shown, not hidden.",
      on: eff.gpuPriority,
      set: (on) => ({ gpuPriority: on }),
    },
    {
      id: "coreParking",
      name: "Core Parking",
      info: "Raises the plugged-in minimum of unparked cores to 100% for the session and restores your value. On hybrid CPUs it also raises the performance-core setting. Battery settings are not changed.",
      on: eff.coreParking,
      set: (on) => ({ coreParking: on }),
    },
    {
      id: "powerThrottling",
      name: "Power Throttling",
      info: "Asks Windows not to treat the game as efficiency (EcoQoS) work. Applies to the game process only and ends with it.",
      on: eff.powerThrottling,
      set: (on) => ({ powerThrottling: on }),
    },
    {
      id: "gameBarCapture",
      name: "Game Bar Capture",
      info: "Turns off background recording and capture for the session. Game Mode stays on and the Game Bar app stays installed, which AMD X3D game detection needs.",
      on: eff.gameBarCapture,
      set: (on) => ({ gameBarCapture: on }),
    },
    {
      id: "timerResolution",
      name: "Timer Resolution",
      info: "Requests a 0.5 ms system timer while the game runs. Uses more power. On Windows 11 it needs a Windows setting that takes one administrator approval and a restart to turn on once.",
      on: eff.timerResolution,
      set: (on) => ({ timerResolution: on }),
    },
    {
      id: "lowerBackground",
      name: "Background Apps",
      info: "Lowers the priority of the apps you picked under Background apps while the game runs. Suspending or closing them is under More actions; closed apps are not reopened.",
      on: eff.lowerBackground,
      set: (on) => ({ lowerBackground: on }),
      extra: (
        <Disclosure title="More actions" hint="Advanced">
          <div className="check-list">
            <label>
              <input
                type="checkbox"
                checked={eff.suspendBackground}
                disabled={blocked("suspendBackground", eff.suspendBackground)}
                onChange={(e) =>
                  void change({ suspendBackground: e.target.checked })
                }
              />
              <span>Suspend the picked apps (resumed afterwards)</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={eff.closeBackground}
                disabled={blocked("closeBackground", eff.closeBackground)}
                onChange={(e) =>
                  void change({ closeBackground: e.target.checked })
                }
              />
              <span>Close the picked apps (not reopened)</span>
            </label>
          </div>
        </Disclosure>
      ),
    },
    {
      id: "gameMode",
      name: "Windows Game Mode",
      info: "Turns on the current-user Game Mode values and restores them afterwards.",
      on: eff.gameMode,
      set: (on) => ({ gameMode: on }),
    },
    {
      id: "pauseServices",
      name: "Pause Services",
      info: "Stops a short list of safe background services for the session, then restarts them. Printing is unavailable while Print Spooler is paused. Start types are never changed.",
      needs:
        "Needs administrator approval when the boost starts and when it ends; declining skips only this step.",
      on: eff.pauseServices,
      set: (on) => ({ pauseServices: on }),
    },
    {
      id: "standbyPurge",
      name: "Standby Purge",
      info: "Empties Windows' cached memory once, when the boost starts. It cannot be undone and it is harmless: Windows refills the cache as programs need it. Auto-boost never does it.",
      needs: "Needs administrator approval.",
      on: eff.standbyPurge,
      set: (on) => ({ standbyPurge: on }),
    },
  ];
  const planFixes = () =>
    unavailable ? null : (
      <>
        {caps && !cap("powerPlan")?.available && !status?.ownedPowerPlan && (
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
        {status?.ownedPowerPlan && (
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
      </>
    );
  const timerFixes = () =>
    unavailable ? null : (
      <>
        {timer?.eligible && !timer.enabled && !timer.ownedByFrameforge && (
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
        {timer?.ownedByFrameforge && (
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
      </>
    );
  return (
    <div className="gm-enhancers" aria-label="Game enhancers">
      <div className="enh-head">
        <small className="muted">
          {off
            ? "Choose a mode to use the enhancers."
            : custom
              ? "Custom: every enhancer is yours to choose."
              : overridden
                ? `${overridden} changed from the ${config.mode} mode.`
                : `Following the ${config.mode} mode.`}
        </small>
        {!custom && !off && overridden > 0 && (
          <Button
            disabled={pending || !!unavailable}
            onClick={() => void save({ overrides: {} })}
          >
            <RotateCcw size={15} /> Reset to mode defaults
          </Button>
        )}
      </div>
      <ul className="enh-list">
        {rows.map((row) => {
          const c = cap(row.id);
          const missing = !!caps && c?.available === false;
          // An unavailable step cannot be turned on, but can always be turned off.
          const disabled = locked || (missing && !row.on);
          const why = missing
            ? `${unsupportedWhenUnavailable.has(row.id) ? "Not supported" : "Not available"} on this PC — ${c.detail}${
                row.id === "timerResolution" && timer && !timer.eligible
                  ? " There is nothing Frameforge can change for this on Windows 10: a timer request only reaches the program that made it. Windows 11 can do this."
                  : ""
              }`
            : "";
          const timerBadge =
            timer && timer.enabled && !timer.restartRequired ? (
              <Badge tone="neutral">
                {timer.ownedByFrameforge
                  ? "on (set by Frameforge)"
                  : "already on in Windows"}
              </Badge>
            ) : timer?.restartRequired ? (
              <Badge tone="amber">restart Windows to finish</Badge>
            ) : timer?.eligible ? (
              <Badge tone="amber">off in Windows</Badge>
            ) : null;
          const fix =
            row.id === "timerResolution"
              ? timerFixes()
              : row.id === "powerPlan"
                ? planFixes()
                : null;
          return (
            <li key={row.id} className="enh-row" data-mechanism={row.id}>
              <span className="enh-name">
                {row.name}
                <InfoTip label={row.name}>
                  {row.info} {row.needs ?? "No administrator approval needed."}
                  {c && !missing ? ` ${c.detail}` : ""}
                </InfoTip>
                {row.needs && <Badge tone="amber">admin</Badge>}
                {row.id === "timerResolution" && timerBadge}
                {missing &&
                  !(row.id === "timerResolution" && timer?.eligible) && (
                    <Badge tone="amber">
                      {unsupportedWhenUnavailable.has(row.id)
                        ? "unsupported"
                        : "unavailable"}
                    </Badge>
                  )}
              </span>
              <Switch.Root
                className="switch"
                aria-label={row.name}
                checked={row.on}
                disabled={disabled}
                onCheckedChange={(on) => void change(row.set(on))}
              >
                <Switch.Thumb className="switch-thumb" />
              </Switch.Root>
              {missing && (
                <small className="enh-note" data-tone="amber">
                  {why}
                </small>
              )}
              {!missing && c?.active && (
                <small className="enh-note muted">Already on: {c.detail}</small>
              )}
              {fix}
              {row.extra && <div className="enh-extra">{row.extra}</div>}
            </li>
          );
        })}
      </ul>
      <Toggle
        label="Auto-boost when a library game starts"
        description={
          unavailable ||
          `Starts a library game's mode when it launches, and ends it when the game exits, even with the window closed to the tray. Turn it off per game in the library.${status?.watching ? " Watching now." : ""}`
        }
        checked={config.autoBoost}
        disabled={pending || !!unavailable}
        onChange={(v) => void save({ autoBoost: v })}
      />
    </div>
  );
}
