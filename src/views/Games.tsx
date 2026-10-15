import { useState } from "react";
import {
  Plus,
  FolderSearch,
  FolderOpen,
  RefreshCw,
  ArrowUpRight,
  Trash2,
  Info,
} from "lucide-react";
import {
  PageTitle,
  Button,
  Badge,
  Empty,
  Modal,
  Panel,
  Chips,
  SearchField,
  LinkButton,
  Disclosure,
  Meter,
  Toggle,
} from "../components/ui";
import {
  sourceLabels,
  type Detection,
  type Game,
} from "../../shared/contracts";
import { GameIcon } from "../components/GameIcon";
import { FpsHistory } from "./monitor/GameMonitor";
import { SessionHistory } from "./gamemode/SessionChanges";
import { RecommendedSettings } from "./games/RecommendedSettings";
import type { ViewProps } from "../types";
export { GameMode } from "./GameBooster";
const modeNames: Record<Game["boostMode"], string> = {
  global: "Use global",
  off: "Off",
  balanced: "Balanced",
  performance: "Performance",
  competitive: "Competitive",
  custom: "Custom",
  smart: "Smart",
};
export function Games({
  data,
  run,
  pending,
  navigate,
  scan: { running, progress },
}: ViewProps) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Game | null>(null);
  const [tab, setTab] = useState<"details" | "recommended">("details");
  const [boostMode, setBoostMode] = useState<Game["boostMode"]>("global");
  const [notes, setNotes] = useState("");
  const [autoBoost, setAutoBoost] = useState(true);
  const [remove, setRemove] = useState<Game | null>(null);
  const [scan, setScan] = useState<Detection | null>(null);
  const [filter, setFilter] = useState<"all" | "custom">("all");
  const [manual, setScanning] = useState(false);
  // Includes a scan started elsewhere (startup, Dashboard) so the library shows it too.
  const scanning = manual || running;
  async function rescan(folder: boolean) {
    setScanning(true);
    try {
      const result = folder
        ? await run("scanFolder", { confirmed: true })
        : await run("detectGames", {});
      // A cancelled folder dialog returns no sources; keep the previous table.
      if (result && result.perLauncher.length) setScan(result);
    } finally {
      setScanning(false);
    }
  }
  const games = data.state.games.filter(
    (g) =>
      g.name.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" || g.boostMode !== "global"),
  );
  const customCount = data.state.games.filter(
    (g) => g.boostMode !== "global",
  ).length;
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
      <div className="lib-toolbar">
        <SearchField
          label="Search games"
          placeholder="Search your games"
          value={search}
          onChange={setSearch}
        />
        <Chips
          label="Filter games"
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: "All games", count: data.state.games.length },
            { id: "custom", label: "Custom mode", count: customCount },
          ]}
        />
        <div className="lib-toolbar-actions">
          <Button
            disabled={pending || scanning || data.mode === "demo"}
            onClick={() => void rescan(false)}
          >
            <RefreshCw size={17} />
            Rescan
          </Button>
          <Button
            disabled={pending || scanning || data.mode === "demo"}
            onClick={() => void rescan(true)}
          >
            <FolderOpen size={17} />
            Scan a folder…
          </Button>
        </div>
      </div>
      {scanning && (
        <Panel tone="accent" role="status" className="lib-scan">
          <FolderSearch size={18} />
          <div>
            <p>
              {progress
                ? `Scanned ${progress.launcher} (${progress.done}/${progress.total}). ${progress.found} games found so far.`
                : "Scanning your PC for installed games…"}
            </p>
            <Meter
              label="Scan progress"
              value={
                progress
                  ? (progress.done / Math.max(1, progress.total)) * 100
                  : 0
              }
            />
          </div>
        </Panel>
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
        <div className="game-grid stagger">
          {games.map((g) => (
            <article className="game-tile" key={g.id}>
              <div className="game-art">
                <GameIcon game={g} size={64} />
              </div>
              <div className="game-content">
                <div className="game-badges">
                  <Badge tone="cyan">{sourceLabels[g.source]}</Badge>
                  {g.boostMode !== "global" && (
                    <Badge tone="lime">{modeNames[g.boostMode]}</Badge>
                  )}
                </div>
                <h2>{g.name}</h2>
                <p className="muted game-path">
                  Booster: {modeNames[g.boostMode]}
                </p>
                <p className="muted game-path" title={g.path}>
                  {g.path}
                </p>
                <div className="card-bottom">
                  <button
                    className="icon-button"
                    title={
                      data.boost.session?.gameId === g.id
                        ? "Stop Game Mode for this game before removing it."
                        : "Remove game"
                    }
                    aria-label={`Remove ${g.name}`}
                    disabled={data.boost.session?.gameId === g.id}
                    onClick={() => setRemove(g)}
                  >
                    <Trash2 size={17} />
                  </button>
                  <Button
                    onClick={() => {
                      setSelected(g);
                      setTab("details");
                      setBoostMode(g.boostMode);
                      setAutoBoost(g.autoBoost !== false);
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
      {data.removedGames.length > 0 && (
        <div className="removed-games">
          <Disclosure title={`Removed games (${data.removedGames.length})`}>
            <p className="muted">
              Scans skip these. Restore one to put it back in your library.
            </p>
            <ul>
              {data.removedGames.map((g) => (
                <li key={g.path}>
                  <div>
                    <strong>{g.name}</strong>
                    <p className="muted setting-path">
                      {sourceLabels[g.source]} · {g.path}
                    </p>
                  </div>
                  <Button
                    disabled={pending}
                    aria-label={`Restore ${g.name}`}
                    onClick={() =>
                      void run(
                        "restoreGame",
                        { path: g.path },
                        "Game restored.",
                      )
                    }
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
      {selected && (
        <Modal
          title={selected.name}
          description="The booster mode applies on the Game Mode page while this game runs. Notes are app-only."
          onClose={() => setSelected(null)}
          variant="drawer"
        >
          <div className="game-heading">
            <GameIcon game={selected} size={56} />
            <p className="setting-path">{selected.path}</p>
          </div>
          <p className="muted">
            {selected.executablePath
              ? `Executable: ${selected.executablePath}`
              : "Matched by folder"}
          </p>
          <p className="muted">Source: {sourceLabels[selected.source]}</p>
          <div className="tabs" role="group" aria-label="Game drawer sections">
            {(
              [
                ["details", "Details"],
                ["recommended", "Recommended settings"],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={tab === id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "recommended" && (
            <RecommendedSettings game={selected} hardware={data.hardware} />
          )}
          {tab === "details" && (
            <>
              <FpsHistory gameId={selected.id} />
              <SessionHistory gameId={selected.id} />
            </>
          )}
          <form
            hidden={tab !== "details"}
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await run(
                  "profile",
                  { id: selected.id, boostMode, autoBoost, notes },
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
            <Toggle
              label="Auto-boost this game"
              description={
                data.state.booster.autoBoost
                  ? "Start the booster by itself when this game launches, even with the window closed to the tray."
                  : "Takes effect once Auto-boost is turned on in Game Mode."
              }
              checked={autoBoost}
              onChange={setAutoBoost}
            />
            <label className="field">
              Configuration notes
              <textarea
                maxLength={500}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <LinkButton onClick={() => navigate("Game Mode")}>
              Launch settings for this game
            </LinkButton>
            <div className="dialog-actions">
              <Button
                type="button"
                variant="danger"
                disabled={data.boost.session?.gameId === selected.id}
                onClick={() => {
                  setRemove(selected);
                  setSelected(null);
                }}
              >
                Remove
              </Button>
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
