import { useState } from "react";
import { Gamepad2, Play, Square, Search, ArrowUpRight, Info } from "lucide-react";
import { PageTitle, Button, Badge, Empty } from "../components/ui";
import type { ProcessTarget } from "../../shared/contracts";
import type { ViewProps } from "../types";
const tones = {
  preparing: "amber",
  active: "lime",
  restoring: "amber",
  "recovery-needed": "red",
  ended: "neutral",
} as const;
export function GameMode({ data, run, pending, navigate }: ViewProps) {
  const [gameId, setGameId] = useState(data.state.games[0]?.id ?? "");
  const [targets, setTargets] = useState<ProcessTarget[] | null>(null);
  const { session, available } = data.boost;
  const game = data.state.games.find((g) => g.id === gameId);
  const sessionGame = data.state.games.find((g) => g.id === session?.gameId);
  const unavailable = !available
    ? data.mode === "demo"
      ? "Game booster requires the desktop app."
      : "The Windows helper is missing, so the game booster is unavailable."
    : "";
  return (
    <>
      <PageTitle
        title="Game Mode"
        subtitle="Temporarily raise a running game's priority, then restore it."
        action={
          <Badge tone={session ? tones[session.status] : "neutral"}>
            {session ? session.status : "Idle"}
          </Badge>
        }
      />
      {unavailable && (
        <div className="notice">
          <Info size={18} />
          {unavailable}
        </div>
      )}
      {session && (
        <section className="session-surface" aria-label="Boost session">
          <h2>{sessionGame?.name ?? "Boosted game"}</h2>
          <p className="muted" role="status">
            {session.message}
          </p>
          <div className="session-details">
            <span>
              Process<strong>{session.target.name} (pid {session.target.pid})</strong>
            </span>
            <span>
              Original priority<strong>{session.target.priority}</strong>
            </span>
          </div>
          <Button
            variant="primary"
            disabled={
              pending || !available || session.status === "preparing" || session.status === "restoring"
            }
            onClick={() =>
              void run("boostStop", { confirmed: true }, "Game priority restore finished.")
            }
          >
            <Square size={17} /> Restore priority
          </Button>
        </section>
      )}
      <section className="session-surface">
        <div className="session-symbol">
          <Gamepad2 size={64} />
        </div>
        <p className="muted">
          Changes only the priority of the running game process. Frameforge verifies the change
          and restores the original priority. It does not claim any FPS gain.
        </p>
        {data.state.games.length ? (
          <>
            <label className="field">
              Selected game
              <select
                disabled={!!session}
                value={gameId}
                onChange={(e) => {
                  setGameId(e.target.value);
                  setTargets(null);
                }}
              >
                {data.state.games.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={pending || !available || !game || !!session}
              title={session ? "Restore the boosted game first." : unavailable}
              onClick={async () => {
                const found = await run("boostTargets", { gameId });
                if (found) setTargets(found);
              }}
            >
              <Search size={17} /> Find running process
            </Button>
            {targets &&
              (targets.length ? (
                <ul className="session-details">
                  {targets.map((target) => (
                    <li key={`${target.pid}-${target.startTime}`}>
                      <span>
                        {target.name} (pid {target.pid})<strong>{target.priority}</strong>
                      </span>
                      <Button
                        variant="primary"
                        disabled={pending || !available || !!session || target.priority !== "Normal"}
                        title={
                          target.priority !== "Normal"
                            ? "Only processes at Normal priority can be raised."
                            : undefined
                        }
                        onClick={async () => {
                          if (
                            await run(
                              "boostStart",
                              { gameId, target, confirmed: true },
                              "Game priority raised.",
                            )
                          )
                            setTargets(null);
                        }}
                      >
                        <Play size={17} /> Raise priority
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted" role="status">
                  No running process found for this game. Start the game, then search again.
                </p>
              ))}
          </>
        ) : (
          <Empty
            title="Add a game first"
            description="A game in your library is needed to find its running process."
            action={
              <Button onClick={() => navigate("Game library")}>
                Open game library
                <ArrowUpRight size={17} />
              </Button>
            }
          />
        )}
      </section>
    </>
  );
}
