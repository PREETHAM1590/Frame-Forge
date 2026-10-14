import { useState } from "react";
import { Eraser } from "lucide-react";
import { Busy, Button } from "../../components/ui";
import { request } from "../../api";
import type {
  CleanupId,
  CleanupPreview,
  CleanupResult,
} from "../../../shared/contracts";
import {
  effectiveSelection,
  formatBytes,
  needsShaderWarning,
  selectable,
  selectedBytes,
  shaderWarning,
} from "../../../shared/cleanup";

/** Opt-in cleanup: look first (sizes only), tick what you want, confirm. Browser caches and the Recycle Bin are never touched. */
export function Cleanup() {
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [picked, setPicked] = useState<CleanupId[]>([]);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };
  const chosen = preview ? effectiveSelection(preview, picked) : [];
  return (
    <section className="system-section" aria-label="Cleanup">
      <h2>
        <Eraser size={20} />
        Cleanup
      </h2>
      <p className="muted">
        Optional. Preview shows sizes and deletes nothing. Browser caches are
        not included, the Recycle Bin is not emptied, and the registry is never
        touched. Files that are in use are skipped.
      </p>
      <Button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            setResult(null);
            setConfirming(false);
            setPreview(await request("cleanupPreview", {}));
            setPicked([]);
          })
        }
      >
        {busy && !preview ? <Busy label="Reading sizes" /> : "Preview cleanup"}
      </Button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <>
          <table className="mon-table">
            <thead>
              <tr>
                <th scope="col">Clean</th>
                <th scope="col">Category</th>
                <th scope="col">Size</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {preview.categories.map((c) => (
                <tr key={c.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Clean ${c.label}`}
                      disabled={!selectable(c) || busy}
                      checked={picked.includes(c.id) && selectable(c)}
                      onChange={(e) =>
                        setPicked(
                          e.target.checked
                            ? [...picked, c.id]
                            : picked.filter((x) => x !== c.id),
                        )
                      }
                    />
                  </td>
                  <td>{c.label}</td>
                  <td>
                    {c.needsAdmin
                      ? "admin only"
                      : !c.present
                        ? "not on this PC"
                        : `${formatBytes(c.bytes ?? 0)} (${c.files.toLocaleString()} files)`}
                  </td>
                  <td>
                    {c.needsAdmin
                      ? "Needs Frameforge run as administrator"
                      : c.minAgeHours > 0
                        ? `Files older than ${c.minAgeHours} hours only`
                        : c.shader
                          ? "Rebuilt by the game"
                          : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {needsShaderWarning(preview, chosen) && (
            <p className="notice-text">{shaderWarning}</p>
          )}
          {!confirming ? (
            <Button
              variant="primary"
              disabled={busy || chosen.length === 0}
              onClick={() => setConfirming(true)}
            >
              Clean{" "}
              {chosen.length
                ? formatBytes(selectedBytes(preview, chosen))
                : "selected"}
            </Button>
          ) : (
            <div className="dialog-actions" role="alert">
              <span>
                Delete {formatBytes(selectedBytes(preview, chosen))} from{" "}
                {chosen.length} categor{chosen.length === 1 ? "y" : "ies"}? This
                cannot be undone.
              </span>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setResult(
                      await request("cleanupRun", {
                        ids: chosen,
                        confirmed: true,
                      }),
                    );
                    setConfirming(false);
                    setPreview(null);
                  })
                }
              >
                {busy ? <Busy label="Cleaning" /> : "Yes, delete"}
              </Button>
              <Button disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
      {result && (
        <div role="status">
          <p>
            <strong>Freed {formatBytes(result.freedBytes)}</strong> (
            {result.deleted.toLocaleString()} files deleted
            {result.skipped
              ? `, ${result.skipped.toLocaleString()} in use or protected were skipped`
              : ""}
            ).
          </p>
          <ul>
            {result.categories.map((c) => (
              <li key={c.id}>
                {c.label}: {formatBytes(c.freedBytes)}. {c.note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
