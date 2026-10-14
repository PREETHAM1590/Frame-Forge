import { ArrowUpRight, Play } from "lucide-react";
import { Button, Empty, Panel } from "../../components/ui";
import { GameIcon } from "../../components/GameIcon";
import type { Game } from "../../../shared/contracts";
import { modes } from "./model";
import type { BoostMode } from "../../../shared/contracts";

/** Launch a game: pick it, see which mode it uses, start. The one primary action of the page. */
export function StartBoost({
  games,
  game,
  gameId,
  gameMode,
  session,
  startReason,
  onPick,
  onStart,
  onOpenLibrary,
}: {
  games: Game[];
  game: Game | undefined;
  gameId: string;
  gameMode: BoostMode;
  session: boolean;
  startReason: string;
  onPick: (id: string) => void;
  onStart: () => void;
  onOpenLibrary: () => void;
}) {
  return (
    <Panel aria-label="Start a boost" className="gm-launch">
      {games.length ? (
        <>
          <div className="gm-launch-row">
            {/* A native <option> cannot hold an image, so the chosen game's icon sits beside the list. */}
            {game && <GameIcon game={game} size={48} />}
            <label className="field">
              Game
              <select
                value={gameId}
                disabled={session}
                onChange={(e) => onPick(e.target.value)}
              >
                {games.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="primary"
              disabled={!!startReason}
              title={startReason || undefined}
              onClick={onStart}
            >
              <Play size={17} /> Start boost
            </Button>
          </div>
          <p className="muted">
            Mode for this game: {modes.find((m) => m.id === gameMode)?.label}
            {game?.boostMode === "global" ? " (global)" : ""}. Start the game
            first.
          </p>
          {startReason && <p className="muted">{startReason}</p>}
        </>
      ) : (
        <Empty
          title="Add a game first"
          description="A game in your library is needed to boost it."
          action={
            <Button onClick={onOpenLibrary}>
              Open game library
              <ArrowUpRight size={17} />
            </Button>
          }
        />
      )}
    </Panel>
  );
}
