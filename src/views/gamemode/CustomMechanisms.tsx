import { Toggle } from "../../components/ui";
import type {
  BoosterConfig,
  CustomMechanisms as Custom,
} from "../../../shared/contracts";
import type { Capability } from "./model";
import type { MechanismId } from "../../../shared/contracts";

/** Every mechanism as its own switch; only shown for the Custom mode. */
export function CustomMechanisms({
  config,
  cap,
  cpus,
  pending,
  setCustom,
}: {
  config: BoosterConfig;
  cap: (id: MechanismId) => Capability | undefined;
  cpus: number;
  pending: boolean;
  setCustom: (next: Partial<Custom>) => unknown;
}) {
  return (
    <section className="gm-sub" aria-label="Custom mechanisms">
      <Toggle
        label="Windows Game Mode"
        description="Turns on the current-user Game Mode values and restores them afterwards."
        checked={config.custom.gameMode}
        disabled={pending}
        onChange={(v) => void setCustom({ gameMode: v })}
      />
      <label className="field">
        Game priority
        <select
          value={config.custom.priority}
          disabled={pending}
          onChange={(e) =>
            void setCustom({
              priority: e.target.value as Custom["priority"],
            })
          }
        >
          <option value="Normal">Normal (unchanged)</option>
          <option value="AboveNormal">Above normal</option>
          <option value="High">High</option>
        </select>
      </label>
      <Toggle
        label="Performance power plan"
        description={
          cap("powerPlan")?.available === false
            ? `Unavailable: ${cap("powerPlan")!.detail}. Create a plan under Mode to use it.`
            : "Switches to High performance (or Ultimate, if present) and back."
        }
        checked={config.custom.powerPlan}
        disabled={
          pending ||
          (cap("powerPlan")?.available === false && !config.custom.powerPlan)
        }
        onChange={(v) => void setCustom({ powerPlan: v })}
      />
      <Toggle
        label="Lower background apps"
        description="Selected apps run at Below normal during the session."
        checked={config.custom.lowerBackground}
        disabled={pending}
        onChange={(v) => void setCustom({ lowerBackground: v })}
      />
      <Toggle
        label="Suspend background apps"
        description="Selected apps are paused during the session and resumed afterwards."
        checked={config.custom.suspendBackground}
        disabled={pending}
        onChange={(v) => void setCustom({ suspendBackground: v })}
      />
      <Toggle
        label="Close background apps"
        description="Selected apps are closed. They are not reopened after the session."
        checked={config.custom.closeBackground}
        disabled={pending}
        onChange={(v) => void setCustom({ closeBackground: v })}
      />
      <Toggle
        label="High timer resolution"
        description={
          cap("timerResolution")?.available === false
            ? `Unsupported: ${cap("timerResolution")!.detail}`
            : "Requests a 0.5 ms timer while the game runs. Uses more power."
        }
        checked={config.custom.timerResolution}
        disabled={pending || cap("timerResolution")?.available === false}
        onChange={(v) => void setCustom({ timerResolution: v })}
      />
      <Toggle
        label="Game Bar capture off"
        description={
          cap("gameBarCapture")?.detail ??
          "Turns off background recording and capture for the session. Game Mode stays on and the Game Bar app stays installed, which AMD X3D game detection needs."
        }
        checked={config.custom.gameBarCapture}
        disabled={pending}
        onChange={(v) => void setCustom({ gameBarCapture: v })}
      />
      <Toggle
        label="Power throttling opt-out"
        description={
          cap("powerThrottling")?.available === false
            ? `Unsupported: ${cap("powerThrottling")!.detail}`
            : "Asks Windows not to treat the game as efficiency (EcoQoS) work. Applies to the game process only."
        }
        checked={config.custom.powerThrottling}
        disabled={
          pending ||
          (cap("powerThrottling")?.available === false &&
            !config.custom.powerThrottling)
        }
        onChange={(v) => void setCustom({ powerThrottling: v })}
      />
      <Toggle
        label="Smart core targeting"
        description={
          cap("smartCores")?.available === false
            ? `Unsupported: ${cap("smartCores")!.detail}`
            : `Steers the game to the performance cores of a hybrid CPU with CPU sets. Off in the presets on Windows 11, where the CPU scheduler already does this; here you can force it. ${cap("smartCores")?.detail ?? "Checking this PC…"}`
        }
        checked={config.custom.smartCores}
        disabled={
          pending ||
          (cap("smartCores")?.available === false && !config.custom.smartCores)
        }
        onChange={(v) => void setCustom({ smartCores: v })}
      />
      <Toggle
        label="Disable core parking"
        description={
          cap("coreParking")?.available === false
            ? `Unsupported: ${cap("coreParking")!.detail}`
            : `Raises the plugged-in minimum of unparked cores to 100% for the session and restores your value. On hybrid CPUs this also raises the performance-core setting (CPMINCORES1) and restores it too. Battery settings are not changed. ${cap("coreParking")?.detail ?? "Checking this PC…"}`
        }
        checked={config.custom.coreParking}
        disabled={
          pending ||
          (cap("coreParking")?.available === false &&
            !config.custom.coreParking)
        }
        onChange={(v) => void setCustom({ coreParking: v })}
      />
      <Toggle
        label="Pause Windows services (asks for administrator approval)"
        description={
          cap("pauseServices")?.available === false
            ? `Unavailable: ${cap("pauseServices")!.detail}`
            : `Stops a short list of safe background services for the session, then restarts them. Windows shows an approval prompt when the boost starts and when it ends; declining the first one skips only this step. Start types are never changed. Printing is unavailable while Print Spooler is paused. ${cap("pauseServices")?.detail ?? "Checking this PC…"}`
        }
        checked={config.custom.pauseServices}
        disabled={
          pending ||
          (cap("pauseServices")?.available === false &&
            !config.custom.pauseServices)
        }
        onChange={(v) => void setCustom({ pauseServices: v })}
      />
      <Toggle
        label="Clear the standby memory list once (asks for administrator approval)"
        description={
          cap("standbyPurge")?.available === false
            ? `Unavailable: ${cap("standbyPurge")!.detail}`
            : `Empties Windows' cached memory once, when the boost starts. It cannot be undone and it is harmless: Windows refills the cache as programs need it. Off by default. Auto-boost never does it. ${cap("standbyPurge")?.detail ?? "Checking this PC…"}`
        }
        checked={config.custom.standbyPurge}
        disabled={
          pending ||
          (cap("standbyPurge")?.available === false &&
            !config.custom.standbyPurge)
        }
        onChange={(v) => void setCustom({ standbyPurge: v })}
      />
      <Toggle
        label="Limit game to selected CPUs"
        description={
          cpus
            ? "Some games run worse with fewer cores. Test before relying on it."
            : "The CPU count is unknown until the desktop helper responds."
        }
        checked={config.custom.affinity !== null}
        disabled={pending || !cpus}
        onChange={(v) =>
          void setCustom({
            affinity: v ? Array.from({ length: cpus }, (_, i) => i) : null,
          })
        }
      />
      {config.custom.affinity && cpus > 0 && (
        <fieldset className="cpu-grid">
          <legend>Logical CPUs</legend>
          {Array.from({ length: cpus }, (_, i) => (
            <label key={i}>
              <input
                type="checkbox"
                checked={config.custom.affinity!.includes(i)}
                disabled={pending}
                onChange={(e) =>
                  void setCustom({
                    affinity: e.target.checked
                      ? [...config.custom.affinity!, i].sort((a, b) => a - b)
                      : config.custom.affinity!.filter((c) => c !== i),
                  })
                }
              />
              CPU {i}
            </label>
          ))}
        </fieldset>
      )}
    </section>
  );
}
