import {
  ArrowUpRight,
  Archive,
  FolderSearch,
  Gamepad2,
  Play,
  SlidersHorizontal,
} from "lucide-react";
import {
  Badge,
  SectionHeader,
  statusTone,
  formatTime,
} from "../../components/ui";
import { GameIcon } from "../../components/GameIcon";
import { protectionChip } from "../Recovery";
import type { Bootstrap, RestoreStatus } from "../../../shared/contracts";
import type { Page } from "../../types";

const cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

/** One row per thing a person does here; each row is a real, working control. */
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
  const session = data.boost.session;
  const sessionGame = data.state.games.find((g) => g.id === session?.gameId);
  const booster = data.state.booster;
  const pointerReady = data.capabilities.includes("mouse-precision");
  const lastScan = data.scan.lastScanAt;
  const chip = protectionChip(restore, data.mode);
  return (
    <section>
      <SectionHeader title="Quick actions" />
      <div className="action-list stagger">
        <button onClick={onPointer}>
          <span className="action-icon lime">
            <SlidersHorizontal />
          </span>
          <div>
            <strong>Consistent pointer movement</strong>
            <p className="muted">
              {pointerReady
                ? "Review a reversible input preference"
                : "Preview only: applying requires the desktop app and its Windows helper"}
            </p>
          </div>
          <ArrowUpRight size={19} />
        </button>
        <button onClick={() => onNavigate("Game library")}>
          <span className="action-icon cyan">
            <Gamepad2 />
          </span>
          <div>
            <strong>Your game library</strong>
            <p className="muted">
              {data.state.games.length
                ? `${data.state.games.length} games in your library`
                : "Add a game and save a profile"}
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
                  ? "Requires the desktop app"
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
        <button onClick={() => onNavigate("Game Mode")}>
          {sessionGame ? (
            <GameIcon game={sessionGame} size={40} />
          ) : (
            <span className="action-icon lime">
              <Play />
            </span>
          )}
          <div>
            <strong>Game Mode</strong>
            <p className="muted">
              {!data.boost.available
                ? data.mode === "demo"
                  ? "Requires the desktop app"
                  : "Windows helper missing"
                : session
                  ? `${sessionGame?.name ?? "Boosted game"}: ${cap(session.mode)} mode, ${session.status}`
                  : `Mode ${cap(booster.mode)}; auto-boost ${booster.autoBoost ? "on" : "off"}; no active session`}
            </p>
          </div>
          <Badge tone={session ? statusTone(session.status) : "neutral"}>
            {session ? session.status : "Idle"}
          </Badge>
        </button>
      </div>
    </section>
  );
}
