import { useEffect, useState } from "react";
import {
  Gamepad2,
  Plus,
  Search,
  FolderSearch,
  FolderOpen,
  RefreshCw,
  ArrowUpRight,
  Trash2,
  Info,
} from "lucide-react";
import { PageTitle, Button, Badge, Empty, Modal } from "../components/ui";
import {
  sourceLabels,
  type Detection,
  type Game,
} from "../../shared/contracts";
import { onEvent } from "../api";
import type { ViewProps } from "../types";
export { GameMode } from "./GameBooster";
const modeNames: Record<Game["boostMode"], string> = {
  global: "Use global",
  off: "Off",
  balanced: "Balanced",
  performance: "Performance",
  competitive: "Competitive",
  custom: "Custom",
};
export function Games({ data, run, pending }: ViewProps) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Game | null>(null);
  const [boostMode, setBoostMode] = useState<Game["boostMode"]>("global");
  const [notes, setNotes] = useState("");
  const [remove, setRemove] = useState<Game | null>(null);
  const [scan, setScan] = useState<Detection | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{
    launcher: string;
    done: number;
    total: number;
    found: number;
  } | null>(null);
  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "scan-progress") setProgress(event);
      }),
    [],
  );
  async function rescan(folder: boolean) {
    setScanning(true);
    setProgress(null);
    try {
      const result = folder
        ? await run("scanFolder", { confirmed: true })
        : await run("detectGames", {});
      // A cancelled folder dialog returns no sources; keep the previous table.
      if (result && result.perLauncher.length) setScan(result);
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }
  const games = data.state.games.filter((g) =>
    g.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        title="Game library"
        subtitle="Your local games and their booster modes."
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
          The native executable picker and installed game detection are
          available in the desktop app.
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
          onClick={() => void rescan(false)}
        >
          <RefreshCw size={17} />
          Rescan
        </Button>
        <Button
          disabled={pending || data.mode === "demo"}
          onClick={() => void rescan(true)}
        >
          <FolderOpen size={17} />
          Scan a folder…
        </Button>
      </div>
      {scanning && (
        <div role="status" className="notice">
          <FolderSearch size={18} />
          <div>
            <p>
              {progress
                ? `Scanned ${progress.launcher} (${progress.done}/${progress.total}). ${progress.found} games found so far.`
                : "Scanning your PC for installed games…"}
            </p>
            <progress
              aria-label="Scan progress"
              max={progress?.total ?? 1}
              value={progress?.done ?? 0}
            />
          </div>
        </div>
      )}
      {scan && !scanning && (
        <div role="status" className="notice">
          <FolderSearch size={18} />
          <div>
            <p>
              {scan.games.length} games found.
              {scan.perLauncher.length > 0 &&
                (scan.launchers.length
                  ? ` Scanned: ${scan.launchers.join(", ")}.`
                  : " No supported launchers found.")}
            </p>
            {scan.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
            {scan.perLauncher.length > 0 && (
              <div className="table-wrap scan-table">
                <table>
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Found</th>
                      <th>Skipped</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scan.perLauncher.map((row) => (
                      <tr key={row.launcher}>
                        <td>{row.launcher}</td>
                        <td>{row.found}</td>
                        <td>{row.skipped}</td>
                        <td>
                          {row.status === "scanned"
                            ? row.found
                              ? "Scanned"
                              : row.launcher === sourceLabels.registry
                                ? "Scanned, none found"
                                : "Installed, no games found"
                            : row.status === "not-installed"
                              ? "Not installed"
                              : "Failed"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      {games.length ? (
        <div className="game-grid">
          {games.map((g) => (
            <article className="game-card" key={g.id}>
              <div className="game-art">
                <Gamepad2 size={48} />
                <span>{g.name.slice(0, 2).toUpperCase()}</span>
              </div>
              <div className="game-content">
                <Badge tone="cyan">{sourceLabels[g.source]}</Badge>
                <h2>{g.name}</h2>
                <p className="muted">Booster: {modeNames[g.boostMode]}</p>
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
                      setBoostMode(g.boostMode);
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
              : "Add a local executable, Rescan to find games from Steam, Epic Games, GOG, Xbox app, EA app, Ubisoft Connect, Battle.net, Riot Games, Rockstar Games and itch.io, or scan a folder."
          }
        />
      )}
      {selected && (
        <Modal
          title={selected.name}
          description="The booster mode applies on the Game Mode page while this game runs. Notes are app-only."
          onClose={() => setSelected(null)}
        >
          <p className="setting-path">{selected.path}</p>
          <p className="muted">
            {selected.executablePath
              ? `Executable: ${selected.executablePath}`
              : "Matched by folder"}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await run(
                  "profile",
                  { id: selected.id, boostMode, notes },
                  "Game settings saved.",
                )
              )
                setSelected(null);
            }}
          >
            <label className="field">
              Booster mode
              <select
                value={boostMode}
                onChange={(e) =>
                  setBoostMode(e.target.value as Game["boostMode"])
                }
              >
                {Object.entries(modeNames).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
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
                Save
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {remove && (
        <Modal
          title="Remove game?"
          description={`Remove ${remove.name} and its settings from the library. Game files stay on disk.`}
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
