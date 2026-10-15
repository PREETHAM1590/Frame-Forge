import { Play } from "lucide-react";
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

export type DashboardState = "nominal" | "boost" | "attention";
const headline: Record<DashboardState, string> = {
  nominal: "Ready to play",
  boost: "Boost running",
  attention: "Worth a look",
};
// Only the states that need explaining get a sentence; "ready" says it all.
const lead: Partial<Record<DashboardState, string>> = {
  boost:
    "A game is running with Game Mode applied. Everything it changed is restored when the game closes.",
  attention:
    "Something on this PC differs from what Frameforge expects. Review the notes below.",
};
const cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

/** The one primary action on the Dashboard: open Game Mode for the next game, or watch the running session. */
export function Hero({
  state,
  data,
  onOpen,
}: {
  state: DashboardState;
  data: Bootstrap;
  onOpen: () => void;
}) {
  const session = data.boost.session;
  const games = data.state.games;
  const booster = data.state.booster;
  const sessionGame = games.find((g) => g.id === session?.gameId);
  const target = sessionGame ?? games[0];
  const sample = session?.samples.at(-1);
  const applied =
    session?.mechanisms.filter((m) => m.state === "applied").length ?? 0;
  const note = session
    ? `${sessionGame?.name ?? "Boosted game"}: ${cap(session.mode)} mode, ${session.status}`
    : !data.boost.available
      ? data.mode === "demo"
        ? "Game Mode needs the desktop app."
        : "Windows helper missing, so Game Mode is unavailable."
      : `Mode ${cap(booster.mode)}; auto-boost ${booster.autoBoost ? "on" : "off"}; no active session`;
  return (
    <Panel tone="accent" className="hero" aria-label="Game Mode status">
      <div className="hero-copy">
        <h1>{headline[state]}</h1>
        <p className="hero-tag">Your setup, in focus.</p>
        {lead[state] && <p className="hero-lead">{lead[state]}</p>}
      </div>
      <div className="hero-play">
        {target && <GameIcon game={target} size={64} />}
        <div className="hero-game">
          <span className="label">
            {session ? "Boosted game" : target ? "Next game" : "Your library"}
          </span>
          <h2>{target?.name ?? "No game yet"}</h2>
          <p className="muted">
            {note}
            {!target && !session && " Scan for games or add one to begin."}
          </p>
        </div>
        <div className="hero-action">
          {session && (
            <Badge tone={statusTone(session.status)}>
              {`Session ${session.status}`}
            </Badge>
          )}
          <Button variant="primary" onClick={onOpen}>
            <Play size={16} />
            {session ? "Open session in Game Mode" : "Open Game Mode"}
          </Button>
        </div>
      </div>
      {session && (
        <div
          className="cells hero-stats"
          style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
        >
          <StatCell
            label="Mode"
            value={cap(session.mode)}
            hint={`Started ${formatTime(session.startedAt)}`}
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
        </div>
      )}
    </Panel>
  );
}
