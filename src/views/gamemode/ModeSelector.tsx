import { Info } from "lucide-react";
import { Panel, Slider } from "../../components/ui";
import type {
  BoostMode,
  BoostSession,
  CustomMechanisms,
} from "../../../shared/contracts";
import type { Status } from "./model";
import { intensity, modes, scale } from "./model";

/** Everyday to Game performance: a slider for the preset modes, with every mode as a labelled step button. */
export function ModeSelector({
  mode,
  pending,
  caps,
  mechanisms,
  onSelect,
}: {
  mode: BoostMode;
  pending: boolean;
  caps: Status["capabilities"] | undefined;
  mechanisms: CustomMechanisms;
  session?: BoostSession | null;
  onSelect: (mode: BoostMode) => void;
}) {
  const current = modes.find((m) => m.id === mode);
  return (
    <Panel className="gm-mode" aria-label="Boost mode panel">
      <h2>Boost mode</h2>
      <div className="tabs gm-steps" role="group" aria-label="Boost mode">
        {modes.map((m) => (
          <button
            key={m.id}
            className={mode === m.id ? "active" : ""}
            aria-pressed={mode === m.id}
            disabled={pending}
            title={pending ? "Wait for the current request." : m.summary}
            onClick={() => onSelect(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p>{current?.summary}</p>
      <p className="muted">
        Not sure? Smart works out what your game needs. Games set to “Use
        global” in the library use this mode. Frameforge does not measure FPS.
      </p>
      <Slider
        label="Everyday use to game performance"
        min={0}
        max={scale.length - 1}
        value={Math.max(0, intensity[mode])}
        valueText={current?.label}
        leftLabel="Everyday"
        rightLabel="Game performance"
        disabled={pending || mode === "custom" || mode === "smart"}
        onChange={(v) => onSelect(scale[v]!)}
      />
      {caps?.topology && (
        <p className="muted" aria-label="Detected CPU layout">
          CPU layout: {caps.topology.summary}
          {caps.topology.dualCcdX3d
            ? " Dual-CCD Ryzen X3D: Frameforge leaves your game's cores and core parking alone."
            : ""}
        </p>
      )}
      {mechanisms.pauseServices && (
        <div className="notice">
          <Info size={18} />
          <div>
            <p>
              <strong>Pausing services needs administrator approval.</strong>{" "}
              Frameforge stops (never disables) a short list of background
              services for the session and restarts them at the end. Windows
              shows one prompt at the start and one at the end. If you decline
              or press Stop, the rest of the boost still runs and no service is
              touched. Auto-boost never shows the prompt. Windows, audio,
              network, input, security, Windows Update, anti-cheat and GPU
              services are never touched. If Frameforge closes unexpectedly,
              paused services return when Windows restarts, or sooner with Retry
              recovery.
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}
