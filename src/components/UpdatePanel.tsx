import { Download } from "lucide-react";
import { Button } from "./ui";
import { useUpdate } from "../useUpdate";
/** Version, release notes (plain text) and the Download / Restart / Install-on-quit actions. */
export function UpdateCard({ always = false }: { always?: boolean }) {
  const { status: s, error, act } = useUpdate();
  if (!s || s.state === "unsupported") return null;
  const actionable = ["available", "downloading", "downloaded"].includes(
    s.state,
  );
  if (!actionable && !always) return null;
  return (
    <div className="notice update-card" role="status">
      <Download size={18} />
      <div>
        {s.state === "checking" && <p>Checking for updates…</p>}
        {s.state === "none" && <p>Frameforge {s.current} is up to date.</p>}
        {s.state === "idle" && <p>Frameforge {s.current}.</p>}
        {s.state === "error" && (
          <p>Could not check for updates: {s.error || "network error"}</p>
        )}
        {s.version && actionable && (
          <>
            <strong>
              Frameforge {s.version} is available (you have {s.current}).
            </strong>
            {s.notes && (
              <pre className="muted" style={{ whiteSpace: "pre-wrap" }}>
                {s.notes}
              </pre>
            )}
          </>
        )}
        {s.state === "downloading" && <p>Downloading… {s.percent}%</p>}
        {s.state === "downloaded" && s.installOnQuit && (
          <p>It will be installed when you quit Frameforge.</p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="row-actions">
          {s.state === "available" && (
            <Button
              variant="primary"
              onClick={() => void act("updateDownload")}
            >
              Download
            </Button>
          )}
          {s.state === "downloaded" && (
            <>
              <Button
                variant="primary"
                onClick={() => void act("updateInstall")}
              >
                Restart to update
              </Button>
              {!s.installOnQuit && (
                <Button onClick={() => void act("updateInstall", "onQuit")}>
                  Install when I quit
                </Button>
              )}
            </>
          )}
          {always &&
            !["checking", "downloading", "downloaded"].includes(s.state) && (
              <Button onClick={() => void act("updateCheck")}>
                Check for updates
              </Button>
            )}
        </div>
      </div>
    </div>
  );
}
