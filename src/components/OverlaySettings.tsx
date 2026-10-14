import { Gauge } from "lucide-react";
import { SegmentedControl, Slider, Toggle } from "./ui";
import {
  overlayCorners,
  resolveOverlay,
  type OverlayConfig,
} from "../../shared/overlay";

const cornerLabels: Record<(typeof overlayCorners)[number], string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
};
const metrics: Array<[keyof OverlayConfig, string]> = [
  ["fps", "FPS"],
  ["low1", "1% low"],
  ["graph", "Frame-time graph"],
  ["cpu", "CPU %"],
  ["gpu", "GPU %"],
  ["ram", "RAM %"],
  ["clock", "Clock"],
];
/** Settings > Overlay. `save` writes the whole overlay block back through the normal settings request. */
export function OverlaySettings({
  saved,
  disabled,
  save,
}: {
  saved: unknown;
  disabled: boolean;
  save: (overlay: OverlayConfig) => void;
}) {
  const config = resolveOverlay(saved);
  const set = (patch: Partial<OverlayConfig>) => save({ ...config, ...patch });
  return (
    <section className="settings-section">
      <h2>
        <Gauge size={20} />
        Overlay
      </h2>
      <Toggle
        label="Show overlay"
        description="Show FPS and system readings over your game while a boost session is active. The tray menu has Toggle overlay for showing it by hand."
        checked={config.enabled}
        disabled={disabled}
        onChange={(enabled) => set({ enabled })}
      />
      <div className="setting-row">
        <div>
          <strong>Corner</strong>
        </div>
        <SegmentedControl
          label="Overlay corner"
          value={config.corner}
          options={overlayCorners.map((value) => ({
            value,
            label: cornerLabels[value],
          }))}
          disabled={disabled}
          onChange={(corner) => set({ corner })}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>Opacity</strong>
        </div>
        <Slider
          label="Overlay opacity"
          min={30}
          max={100}
          step={5}
          value={Math.round(config.opacity * 100)}
          valueText={`${Math.round(config.opacity * 100)} percent`}
          leftLabel="30%"
          rightLabel="100%"
          disabled={disabled}
          onChange={(v) => set({ opacity: v / 100 })}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>Size</strong>
        </div>
        <Slider
          label="Overlay size"
          min={75}
          max={200}
          step={25}
          value={Math.round(config.scale * 100)}
          valueText={`${Math.round(config.scale * 100)} percent`}
          leftLabel="75%"
          rightLabel="200%"
          disabled={disabled}
          onChange={(v) => set({ scale: v / 100 })}
        />
      </div>
      {metrics.map(([key, label]) => (
        <Toggle
          key={key}
          label={`Overlay: ${label}`}
          description={
            key === "fps"
              ? "FPS needs the Game Monitor capture, which asks Windows for administrator approval once. Without it the overlay shows CPU, GPU and RAM only."
              : `Show ${label} on the overlay.`
          }
          checked={config[key] as boolean}
          disabled={disabled}
          onChange={(v) => set({ [key]: v })}
        />
      ))}
      <p className="muted">
        The overlay is its own transparent window; Frameforge never injects into
        or hooks a game, so anti-cheat is unaffected. It appears over borderless
        and windowed games. Exclusive-fullscreen DirectX games may hide it:
        switch the game to borderless to see it.
      </p>
    </section>
  );
}
