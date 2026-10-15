import {
  ArrowUpRight,
  Archive,
  FolderSearch,
  SlidersHorizontal,
} from "lucide-react";
import { Badge, SectionHeader, formatTime } from "../../components/ui";
import { protectionChip } from "../Recovery";
import type { Bootstrap, RestoreStatus } from "../../../shared/contracts";
import type { Page } from "../../types";

/** The three things people do from here besides playing; each row is a real, working control. */
export function QuickActions({
  data,
  restore,
  scanning,
  scanProgress,
  busy,
  onPointer,
  onScan,
  onNavigate,
}: {
  data: Bootstrap;
  restore: RestoreStatus | null;
  scanning: boolean;
  scanProgress: {
    launcher: string;
    done: number;
    total: number;
    found: number;
  } | null;
  busy: boolean;
  onPointer: () => void;
  onScan: () => void;
  onNavigate: (page: Page) => void;
}) {
  const pointerReady = data.capabilities.includes("mouse-precision");
  const lastScan = data.scan.lastScanAt;
  const chip = protectionChip(restore, data.mode);
  return (
    <section className="dash-card">
      <SectionHeader title="Quick actions" />
      <div className="action-list">
        <button onClick={onPointer}>
          <span className="action-icon lime">
            <SlidersHorizontal />
          </span>
          <div>
            <strong>Consistent pointer movement</strong>
            <p className="muted">
              {pointerReady
                ? "Turn off mouse acceleration. Reversible."
                : "Preview only: applying needs the desktop app and its Windows helper."}
            </p>
          </div>
          <ArrowUpRight size={19} />
        </button>
        <button
          disabled={busy || scanning || data.mode === "demo"}
          onClick={onScan}
        >
          <span className="action-icon cyan">
            <FolderSearch />
          </span>
          <div>
            <strong>{scanning ? "Scanning for games…" : "Scan now"}</strong>
            <p className="muted">
              {scanning
                ? scanProgress
                  ? `${scanProgress.launcher} (${scanProgress.done}/${scanProgress.total}), ${scanProgress.found} found so far`
                  : "Looking through your launchers in the background"
                : data.mode === "demo"
                  ? "Needs the desktop app"
                  : lastScan
                    ? `Find installed games. Last scan ${formatTime(lastScan)}`
                    : "Find installed games and add them to your library"}
            </p>
            {scanning && (
              <progress
                aria-label="Game scan progress"
                max={scanProgress?.total ?? 1}
                value={scanProgress?.done ?? 0}
              />
            )}
          </div>
          <ArrowUpRight size={19} />
        </button>
        <button onClick={() => onNavigate("Restore & backups")}>
          <span className="action-icon amber">
            <Archive />
          </span>
          <div>
            <strong>Keep a way back</strong>
            <p className="muted">
              {data.backups.length} app configuration backup
              {data.backups.length === 1 ? "" : "s"}
            </p>
          </div>
          <Badge tone={chip.tone}>{chip.text}</Badge>
        </button>
      </div>
    </section>
  );
}
