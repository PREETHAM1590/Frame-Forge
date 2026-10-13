import { Play, Zap } from "lucide-react";
import {
  Badge,
  Button,
  Panel,
  StatCell,
  statusTone,
} from "../../components/ui";
import { formatTime } from "../../components/ui";
import { GameIcon } from "../../components/GameIcon";
import type { Bootstrap } from "../../../shared/contracts";

const cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

/** The one primary action on the Dashboard: open Game Mode, or watch the running session. */
export function BoostPanel({
  data,
  onOpen,
}: {
  data: Bootstrap;
  onOpen: () => void;
}) {
  const session = data.boost.session;
  const games = data.state.games;
  const sessionGame = games.find((g) => g.id === session?.gameId);
  const target = sessionGame ?? games[0];
  const sample = session?.samples.at(-1);
  const applied =
    session?.mechanisms.filter((m) => m.state === "applied").length ?? 0;
  return (
    <Panel tone="accent" className="boost-panel" aria-label="Game Mode status">
      <div className="boost-head">
        <span className="label">
          <Zap size={13} /> Subsystem dispatch
        </span>
        <Badge tone={session ? statusTone(session.status) : "neutral"}>
          {session ? `Session ${session.status}` : "Idle"}
        </Badge>
      </div>
      <div className="boost-target">
        <div>
          <span className="label">
            {session ? "Boosted application" : "Next game in your library"}
          </span>
          <h2>{target?.name ?? "No game yet"}</h2>
          <p className="muted">
            {session
              ? `Started ${formatTime(session.startedAt)}`
              : !data.boost.available
                ? data.mode === "demo"
                  ? "Game Mode needs the desktop app."
                  : "The Windows helper is missing, so Game Mode is unavailable."
                : target
                  ? "Open Game Mode to choose how this PC is tuned while you play."
                  : "Scan your launchers or add a game executable to begin."}
          </p>
        </div>
        {target && (
          <span className="boost-icon">
            <GameIcon game={target} size={72} />
          </span>
        )}
      </div>
      <div
        className="cells boost-stats"
        style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
      >
        {session ? (
          <>
            <StatCell
              label="Mode"
              value={cap(session.mode)}
              hint={`Status: ${session.status}`}
            />
            <StatCell
              label="System CPU"
              count={sample?.systemCpuPercent ?? 0}
              unit="%"
              hint={sample ? "Latest sample" : "Sampling"}
              meter={{
                value: sample?.systemCpuPercent ?? 0,
                label: "System CPU load",
              }}
            />
            <StatCell
              label="Changes applied"
              count={applied}
              hint={`of ${session.mechanisms.length} reported`}
            />
          </>
        ) : (
          <>
            <StatCell
              label="Saved mode"
              value={cap(data.state.booster.mode)}
              hint="Used by auto-boost and the next start"
            />
            <StatCell
              label="Auto-boost"
              value={data.state.booster.autoBoost ? "On" : "Off"}
              hint="Starts when a library game opens"
            />
            <StatCell
              label="Library"
              count={games.length}
              hint={games.length === 1 ? "game saved" : "games saved"}
            />
          </>
        )}
      </div>
      <Button variant="primary" block onClick={onOpen}>
        <Play size={16} />
        {session ? "Open session in Game Mode" : "Open Game Mode"}
      </Button>
    </Panel>
  );
}
