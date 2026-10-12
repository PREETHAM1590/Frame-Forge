import { useState } from "react";
import {
  Gamepad2,
  Plus,
  Search,
  FolderSearch,
  ArrowUpRight,
  Trash2,
  Info,
} from "lucide-react";
import { PageTitle, Button, Badge, Empty, Modal } from "../components/ui";
import type { Game } from "../../shared/contracts";
import type { ViewProps } from "../types";
export { GameMode } from "./GameBooster";
export function Games({ data, run, pending }: ViewProps) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Game | null>(null);
  const [profile, setProfile] = useState<Game["profile"]>("balanced");
  const [notes, setNotes] = useState("");
  const [remove, setRemove] = useState<Game | null>(null);
  const [scan, setScan] = useState<{ count: number; warnings: string[]; launchers: string[] } | null>(null);
  const games = data.state.games.filter((g) =>
    g.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        title="Game library"
        subtitle="Your local games. Your own configuration profiles."
        action={
          <Button
            variant="primary"
            disabled={pending || data.mode === "demo"}
            onClick={() => void run("addGame", {}, "Game added.")}
          >
            <Plus size={17} />
            Add game
          </Button>
        }
      />
      {data.mode === "demo" && (
        <div className="notice">
          <Info size={18} />
          The native executable picker and installed game detection are available in the
          desktop app.
        </div>
      )}
      <div className="toolbar">
        <div className="search">
          <Search size={18} />
          <input
            placeholder="Search your games"
            aria-label="Search games"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          disabled={pending || data.mode === "demo"}
          onClick={async () => {
            const result = await run("detectGames", {});
            if (result) setScan({ count: result.games.length, warnings: result.warnings, launchers: result.launchers });
          }}
        >
          <FolderSearch size={17} />
          Scan installed games
        </Button>
      </div>
      {scan && <div role="status" className="notice"><FolderSearch size={18} /><div><p>{scan.count} installed games found. {scan.launchers.length ? `Scanned: ${scan.launchers.join(", ")}.` : "No supported launchers found."}</p>{scan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
      {games.length ? (
        <div className="game-grid">
          {games.map((g) => (
            <article className="game-card" key={g.id}>
              <div className="game-art">
                <Gamepad2 size={48} />
                <span>{g.name.slice(0, 2).toUpperCase()}</span>
              </div>
              <div className="game-content">
                <Badge tone="cyan">{g.source}</Badge>
                <h2>{g.name}</h2>
                <p className="muted">{g.profile} profile</p>
                <div className="card-bottom">
                  <button
                    className="icon-button"
                    title="Remove game"
                    aria-label={`Remove ${g.name}`}
                    onClick={() => setRemove(g)}
                  >
                    <Trash2 size={17} />
                  </button>
                  <Button
                    onClick={() => {
                      setSelected(g);
                      setProfile(g.profile);
                      setNotes(g.notes);
                    }}
                  >
                    Game details
                    <ArrowUpRight size={16} />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title={search ? "No matching games" : "Your library starts here"}
          description={
            search
              ? "Try a different game name."
              : "Add a local executable or scan installed Steam, Epic, GOG and Xbox games."
          }
        />
      )}
      {selected && (
        <Modal
          title={selected.name}
          description="Profiles are app configuration only. They do not edit the game or Windows."
          onClose={() => setSelected(null)}
        >
          <p className="setting-path">{selected.path}</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await run(
                  "profile",
                  { id: selected.id, profile, notes },
                  "Game profile saved.",
                )
              )
                setSelected(null);
            }}
          >
            <label className="field">
              Profile
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value as Game["profile"])}
              >
                <option value="balanced">Balanced</option>
                <option value="gaming">Gaming</option>
                <option value="quiet">Quiet</option>
              </select>
            </label>
            <label className="field">
              Configuration notes
              <textarea
                maxLength={500}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <Button type="button" onClick={() => setSelected(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={pending}>
                Save profile
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {remove && (
        <Modal
          title="Remove game?"
          description={`Remove ${remove.name} and its app profile from the library. Game files stay on disk.`}
          onClose={() => setRemove(null)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setRemove(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={async () => {
                if (await run("removeGame", { id: remove.id }, "Game removed."))
                  setRemove(null);
              }}
            >
              Remove game
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function GameMode({ data, run, pending, navigate }: ViewProps) {
  const [gameId, setGameId] = useState(
    data.state.gameMode.gameId ?? data.state.games[0]?.id ?? "",
  );
  const game = data.state.games.find((g) => g.id === gameId);
  const active = data.state.gameMode.active;
  return (
    <>
      <PageTitle
        title="Game Mode"
        subtitle="Keep a selected game profile at hand for your session."
        action={
          <Badge tone={active ? "lime" : "neutral"}>
            {active ? "Profile session active" : "Idle"}
          </Badge>
        }
      />
      <section className="session-surface">
        <div className="session-symbol">
          <Gamepad2 size={64} />
        </div>
        <h2>
          {active ? "Your session is ready." : "Choose your next session."}
        </h2>
        <p className="muted">
          App-only profile session. Automatic Windows tuning and game launching
          are unsupported.
        </p>
        {data.state.games.length ? (
          <>
            <label className="field">
              Selected game
              <select
                disabled={active}
                value={gameId}
                onChange={(e) => setGameId(e.target.value)}
              >
                {data.state.games.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            {game && (
              <div className="session-details">
                <span>
                  Profile<strong>{game.profile}</strong>
                </span>
                <span>
                  Windows changes<strong>None</strong>
                </span>
                <span>
                  Notes<strong>{game.notes || "No notes saved"}</strong>
                </span>
              </div>
            )}
            <Button
              variant={active ? "secondary" : "primary"}
              disabled={pending || !game}
              onClick={() =>
                void run(
                  "gameMode",
                  { active: !active, gameId: active ? null : gameId },
                  active
                    ? "Profile session ended."
                    : "Profile session started.",
                )
              }
            >
              {active ? <Square size={17} /> : <Play size={17} />}{" "}
              {active ? "End session" : "Start profile session"}
            </Button>
          </>
        ) : (
          <Empty
            title="Add a game first"
            description="A saved game profile is needed to start a session."
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
