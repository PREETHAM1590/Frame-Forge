import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Badge, Button, Toggle } from "../components/ui";
import { request } from "../api";
import {
  acceleratorFromEvent,
  defaultHotkeys,
  hotkeyIds,
  hotkeyLabels,
  parseAccelerator,
  type HotkeyId,
  type Hotkeys,
} from "../../shared/hotkeys";

/** Settings > Hotkeys: global shortcuts (they work from the tray), a key recorder, conflict marks and reset. */
export function HotkeysSection({
  hotkeys,
  pending,
  save,
}: {
  hotkeys: Hotkeys;
  pending: boolean;
  save: (next: Hotkeys) => void;
}) {
  const [recording, setRecording] = useState<HotkeyId | null>(null);
  const [problem, setProblem] = useState("");
  const [status, setStatus] = useState<{
    supported: boolean;
    failed: string[];
  }>({ supported: true, failed: [] });
  useEffect(() => {
    let live = true;
    request("hotkeyStatus", {})
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ supported: false, failed: [] }));
    return () => {
      live = false;
    };
  }, [hotkeys]);
  const record = (id: HotkeyId, e: React.KeyboardEvent) => {
    e.preventDefault();
    if (e.code === "Escape") return setRecording(null);
    const raw = acceleratorFromEvent(e.nativeEvent);
    if (!raw) return;
    const parsed = parseAccelerator(raw);
    if (!parsed.ok) return setProblem(parsed.error);
    const other = hotkeyIds.find(
      (o) => o !== id && hotkeys.bindings[o] === parsed.accelerator,
    );
    if (other)
      return setProblem(
        `${parsed.accelerator} is already used by "${hotkeyLabels[other]}".`,
      );
    setProblem("");
    setRecording(null);
    save({
      ...hotkeys,
      bindings: { ...hotkeys.bindings, [id]: parsed.accelerator },
    });
  };
  if (!status.supported)
    return (
      <section className="settings-section">
        <h2>
          <Keyboard size={20} />
          Hotkeys
        </h2>
        <p className="muted">
          Global hotkeys are available in the desktop app.
        </p>
      </section>
    );
  return (
    <section className="settings-section">
      <h2>
        <Keyboard size={20} />
        Hotkeys
      </h2>
      <Toggle
        label="Enable global hotkeys"
        description="Work anywhere in Windows, including while Frameforge is in the tray. Off: nothing is registered with Windows."
        checked={hotkeys.enabled}
        disabled={pending}
        onChange={(enabled) => save({ ...hotkeys, enabled })}
      />
      <Toggle
        label="Allow admin prompts from hotkeys"
        description="Off: a boost started with a hotkey skips the steps that need administrator approval (services, standby list), so Windows never asks mid-game."
        checked={hotkeys.allowAdmin}
        disabled={pending || !hotkeys.enabled}
        onChange={(allowAdmin) => save({ ...hotkeys, allowAdmin })}
      />
      {hotkeyIds.map((id) => (
        <div className="setting-row" key={id}>
          <div>
            <label htmlFor={`hotkey-${id}`}>{hotkeyLabels[id]}</label>
            {hotkeys.enabled && status.failed.includes(id) && (
              <p className="muted">
                <Badge tone="amber">Conflict</Badge> Another app already uses{" "}
                {hotkeys.bindings[id]}. Pick a different combination.
              </p>
            )}
          </div>
          <Button
            id={`hotkey-${id}`}
            disabled={pending || !hotkeys.enabled}
            onClick={() => {
              setProblem("");
              setRecording(recording === id ? null : id);
            }}
            onKeyDown={(e) => recording === id && record(id, e)}
            onBlur={() => recording === id && setRecording(null)}
          >
            {recording === id
              ? "Press keys (Esc cancels)"
              : hotkeys.bindings[id]}
          </Button>
        </div>
      ))}
      {problem && (
        <p className="muted" role="alert">
          {problem}
        </p>
      )}
      <div className="setting-row">
        <p className="muted">
          Shortcuts need Ctrl or Alt. Windows key combinations are reserved.
        </p>
        <Button
          disabled={pending}
          onClick={() => {
            setProblem("");
            setRecording(null);
            save(defaultHotkeys);
          }}
        >
          Reset to defaults
        </Button>
      </div>
    </section>
  );
}
