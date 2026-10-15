import { useEffect, useRef, useState } from "react";
import { ListRestart, Plus } from "lucide-react";
import { Badge, Busy, Button, SegmentedControl } from "../../components/ui";
import { AppIcon, clearAppIcons } from "../../components/AppIcon";
import { request } from "../../api";
import {
  backgroundRows,
  neverTouch,
  totals,
  type BackgroundAction,
  type BackgroundRow,
} from "../../../shared/background";
import type {
  BoosterConfig,
  Game,
  RunningProcess,
} from "../../../shared/contracts";

type Rules = BoosterConfig["background"];
const actionLabel: Record<BackgroundAction, string> = {
  suspend: "Pause (resume after)",
  lower: "Lower priority",
  close: "Close (not reopened)",
};
const mb = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

/**
 * "Close or pause apps while gaming": running programs grouped by app, heavy non-essential ones suggested and pre-ticked.
 * The choice is saved for all games, or only for the picked game. Until you save your own list, Smart mode uses the suggested set.
 */
export function BackgroundApps({
  config,
  game,
  save,
  saveGame,
  pending,
  unavailable,
  desktop,
}: {
  config: BoosterConfig;
  game: Game | undefined;
  save: (next: Partial<BoosterConfig>) => Promise<unknown>;
  saveGame: (background: Rules | null) => Promise<unknown>;
  pending: boolean;
  unavailable: string;
  desktop: boolean;
}) {
  const [processes, setProcesses] = useState<RunningProcess[] | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<"all" | "game">("all");
  const [added, setAdded] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!desktop || unavailable) return;
    let active = true;
    clearAppIcons();
    request("runningProcesses", {})
      .then((list) => {
        if (!active) return;
        setProcesses(list);
        setError("");
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : "Could not read running apps.",
          );
      });
    return () => {
      active = false;
    };
  }, [desktop, unavailable, tick]);
  const loading = desktop && !unavailable && !processes && !error;

  const perGame = scope === "game" && !!game;
  const hasOverride = !!game?.background;
  const saved: Rules = perGame
    ? (game?.background ?? config.background)
    : config.background;
  const chosen = perGame
    ? hasOverride || !!config.backgroundChosen || config.background.length > 0
    : !!config.backgroundChosen || config.background.length > 0;
  const image = game?.executablePath?.split(/[\\/]/).pop();
  const rows = backgroundRows(processes ?? [], saved, chosen, {
    gameImage: image,
    gameSource: game?.source,
  });
  const sum = totals(rows);

  async function write(next: Rules) {
    if (perGame) await saveGame(next);
    else await save({ background: next, backgroundChosen: true });
  }
  const materialize = (
    row: BackgroundRow,
    patch: Partial<{ on: boolean; action: BackgroundAction }>,
  ): Rules => {
    const list = rows
      .filter((r) =>
        r.key === row.key ? (patch.on ?? r.selected) : r.selected,
      )
      .map((r) => ({
        image: r.image,
        action:
          r.key === row.key ? (patch.action ?? r.chosenAction) : r.chosenAction,
      }));
    return list.slice(0, 50);
  };
  function addFile(file: File | undefined) {
    if (!file) return;
    const name = file.name;
    setAdded("");
    if (!/^[\w .()-]{1,64}\.exe$/i.test(name)) {
      setAdded(`${name} is not a program Frameforge can list.`);
      return;
    }
    const why = neverTouch(name);
    if (why) {
      setAdded(`${name} cannot be added: ${why}`);
      return;
    }
    if (rows.some((r) => r.key === name.toLowerCase() && r.selected)) {
      setAdded(`${name} is already on the list.`);
      return;
    }
    if (saved.length >= 50) {
      setAdded("The list is full (50 apps). Remove one first.");
      return;
    }
    const keep = rows
      .filter((r) => r.selected)
      .map((r) => ({ image: r.image, action: r.chosenAction }));
    void write([
      ...keep.filter((k) => k.image.toLowerCase() !== name.toLowerCase()),
      { image: name, action: "lower" },
    ]);
    setAdded(`${name} added (lower priority). Change the action in its row.`);
  }
  return (
    <section className="apps" aria-label="Apps to close or pause while gaming">
      <p className="muted">
        Apps in your own Windows session only. System, security, anti-cheat,
        voice chat, audio, input and overlay programs, and the game&apos;s own
        launcher, are never suggested. Pausing and lowering are undone when the
        game ends; closing is not (the app is not reopened).
      </p>
      {game && (
        <SegmentedControl
          label="Apply this list to"
          value={scope}
          options={[
            { value: "all", label: "All games" },
            { value: "game", label: `Only ${game.name}` },
          ]}
          onChange={setScope}
        />
      )}
      {perGame && (
        <p className="muted">
          {hasOverride
            ? `${game!.name} has its own list.`
            : `${game!.name} uses the all-games list until you change something here.`}
          {hasOverride && (
            <>
              {" "}
              <Button disabled={pending} onClick={() => void saveGame(null)}>
                Use the all-games list again
              </Button>
            </>
          )}
        </p>
      )}
      {!chosen && (
        <p className="notice" role="status">
          You have not chosen your own list yet. The ticked apps below are the
          suggested ones; Smart mode uses them as they are. Change a tick to
          save your own choice.
        </p>
      )}
      <p className="apps-totals" aria-live="polite">
        {sum.count === 0
          ? "No apps selected: a CPU-limited game keeps competing with whatever is running."
          : `${sum.count} app${sum.count === 1 ? "" : "s"} selected. ${sum.closeBytes ? `Closing frees about ${mb(sum.closeBytes)} of memory. ` : ""}${sum.heldBytes ? `Pausing or lowering ${mb(sum.heldBytes)} of apps stops their CPU use but does not free their memory. ` : ""}${sum.cpuPercent >= 0.5 ? `They use about ${sum.cpuPercent.toFixed(0)}% of the CPU now.` : ""}`}
      </p>
      <div className="toolbar">
        <Button
          disabled={pending || !!unavailable}
          title={unavailable || "Read the apps running now."}
          onClick={() => setTick((n) => n + 1)}
        >
          <ListRestart size={17} /> Refresh list
        </Button>
        <Button
          disabled={pending || !!unavailable}
          title={unavailable || "Pick a program that is not running now."}
          onClick={() => input.current?.click()}
        >
          <Plus size={17} /> Add app…
        </Button>
        <input
          ref={input}
          type="file"
          accept=".exe"
          hidden
          aria-label="Choose a program to add"
          onChange={(e) => {
            addFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {chosen && !perGame && (
          <Button
            disabled={pending}
            title="Forget your list and go back to the suggested apps."
            onClick={() =>
              void save({ background: [], backgroundChosen: false })
            }
          >
            Use suggestions again
          </Button>
        )}
      </div>
      {added && (
        <p className="muted" role="status">
          {added}
        </p>
      )}
      {error && (
        <p className="notice" role="alert" data-error="true">
          {error}
        </p>
      )}
      {unavailable && <p className="muted">{unavailable}</p>}
      {loading && !processes && <Busy label="Reading running apps" />}
      {processes && (
        <ul className="apps-list" aria-label="Running apps">
          {rows.map((row) => {
            const blocked = !!row.blocked;
            return (
              <li
                key={row.key}
                className={`apps-row ${row.selected ? "selected" : ""}`}
              >
                <input
                  type="checkbox"
                  aria-label={`${row.selected ? "Stop handling" : "Handle"} ${row.name} while gaming`}
                  checked={row.selected}
                  disabled={pending || (blocked && !row.selected)}
                  onChange={(e) =>
                    void write(materialize(row, { on: e.target.checked }))
                  }
                />
                <AppIcon image={row.image} name={row.name} desktop={desktop} />
                <span className="apps-name">
                  <strong title={row.path ?? row.image}>
                    {row.name}
                    {row.processes > 1 ? ` (${row.processes})` : ""}
                  </strong>
                  <small>
                    {row.suggested && (
                      <>
                        <Badge tone="lime">SUGGESTED</Badge>{" "}
                      </>
                    )}
                    {blocked && !row.selected && (
                      <Badge tone="neutral">keeps running</Badge>
                    )}{" "}
                    {row.reason}
                  </small>
                </span>
                <span className="apps-usage">
                  {row.processes > 0
                    ? `${mb(row.ramBytes)} · ${row.cpuPercent.toFixed(row.cpuPercent < 10 ? 1 : 0)}% CPU`
                    : "not running"}
                </span>
                <select
                  aria-label={`Action for ${row.name}`}
                  value={row.chosenAction}
                  disabled={pending || !row.selected}
                  onChange={(e) =>
                    void write(
                      materialize(row, {
                        action: e.target.value as BackgroundAction,
                      }),
                    )
                  }
                >
                  {(["suspend", "lower", "close"] as const).map((a) => (
                    <option key={a} value={a}>
                      {actionLabel[a]}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
          {!rows.length && <li className="apps-row">No apps found.</li>}
        </ul>
      )}
      {!desktop && (
        <p className="muted">Reading running apps needs the desktop app.</p>
      )}
    </section>
  );
}
