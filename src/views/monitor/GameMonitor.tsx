import { useCallback, useEffect, useState } from "react";
import { Gauge, Play, Square } from "lucide-react";
import { Badge, Busy, Button, Panel, SectionHeader } from "../../components/ui";
import { onEvent, request } from "../../api";
import { usePageVisible } from "../../useMonitor";
import { AreaChart } from "./Charts";
import { formatSize, fpsText, percent } from "./format";
import type {
  Bootstrap,
  FpsStatus,
  FpsSummary,
} from "../../../shared/contracts";
const boostText = {
  on: "Game Mode on",
  off: "Game Mode off",
  mixed: "Game Mode changed during capture",
} as const;
const duration = (s: number) =>
  s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;

/** Saved FPS captures for one game, newest first. Quiet when there are none (or in the browser preview). */
export function FpsHistory({
  gameId,
  limit = 5,
}: {
  gameId: string;
  limit?: number;
}) {
  const [rows, setRows] = useState<FpsSummary[]>([]);
  useEffect(() => {
    let live = true;
    request("fpsHistory", { gameId })
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [gameId]);
  if (rows.length === 0) return null;
  return (
    <div className="fps-history">
      <span className="label">Measured FPS</span>
      <table className="mon-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Average</th>
            <th scope="col">1% low</th>
            <th scope="col">Length</th>
            <th scope="col">Game Mode</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r) => (
            <tr key={r.id}>
              <td>
                {new Date(r.at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </td>
              <td className="mono">{r.avgFps.toFixed(0)} FPS</td>
              <td className="mono">
                {r.low1Fps === null ? "-" : `${r.low1Fps.toFixed(0)} FPS`}
              </td>
              <td className="mono">{duration(r.durationSeconds)}</td>
              <td>
                {r.boost === "mixed"
                  ? "Mixed"
                  : r.boost === "on"
                    ? "On"
                    : "Off"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mon-note">
        Same game, same scene, Game Mode on and off is the fair comparison.
        Frameforge reports what was measured and does not promise a gain.
      </p>
    </div>
  );
}

/** FPS and frame times for a running game. Capture needs one Windows administrator approval, so it starts only on a click. */
export function GameMonitor({ data }: { data: Bootstrap }) {
  const visible = usePageVisible();
  const [status, setStatus] = useState<FpsStatus | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const games = data.state.games;
  useEffect(() => {
    if (!visible) return;
    let live = true;
    const load = () =>
      request("fpsStatus", {})
        .then((s) => live && setStatus(s))
        .catch(() => undefined);
    void load();
    const off = onEvent((event) => {
      // Events carry no running-game list; keep the last one.
      if (event.type === "fps")
        setStatus((old) => ({ ...event.status, running: old?.running ?? [] }));
    });
    // Running games change as people launch them; poll only while idle, and only while the page is visible.
    const timer = setInterval(() => {
      setStatus((old) => {
        if (!old || (old.state !== "capturing" && old.state !== "starting"))
          void load();
        return old;
      });
    }, 5000);
    return () => {
      live = false;
      off();
      clearInterval(timer);
    };
  }, [visible]);
  const boosted = data.boost.session?.gameId;
  const selected =
    picked ||
    (boosted && games.some((g) => g.id === boosted) ? boosted : "") ||
    status?.running[0] ||
    games[0]?.id ||
    "";
  const running = status?.running.includes(selected) ?? false;
  const active = status?.state === "starting" || status?.state === "capturing";
  const act = useCallback(async (go: () => Promise<FpsStatus>) => {
    setBusy(true);
    setError("");
    try {
      const next = await go();
      setStatus((old) => ({
        ...next,
        running: next.running.length ? next.running : (old?.running ?? []),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }, []);
  const s = status;
  const peak = Math.max(34, ...(s?.frameTimes ?? [0]));
  const fpsPeak = Math.max(60, ...(s?.fpsHistory ?? [0]));
  return (
    <Panel className="game-monitor">
      <SectionHeader
        title="Game monitor"
        icon={<Gauge size={18} />}
        level={3}
        aside={
          s && s.state !== "idle" ? (
            <Badge
              tone={
                s.state === "capturing"
                  ? "lime"
                  : s.state === "unavailable"
                    ? "amber"
                    : "neutral"
              }
            >
              {s.state === "capturing"
                ? "Measuring"
                : s.state === "starting"
                  ? "Waiting for approval"
                  : s.state === "ended"
                    ? "Finished"
                    : "Unavailable"}
            </Badge>
          ) : undefined
        }
      />
      <p className="muted">
        Live FPS, 1% low and frame times for a running game. Frameforge reads
        Windows' DirectX present events (it does not touch the game), which
        needs one administrator approval each time you start.
      </p>
      {games.length === 0 ? (
        <p className="muted">Add a game to the library to measure it.</p>
      ) : (
        <div className="fps-controls">
          <label className="field">
            Game
            <select
              value={selected}
              disabled={active}
              onChange={(e) => setPicked(e.target.value)}
            >
              {games.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {status?.running.includes(g.id) ? " (running)" : ""}
                </option>
              ))}
            </select>
          </label>
          {active ? (
            <Button
              disabled={busy}
              onClick={() =>
                void act(() => request("fpsStop", { confirmed: true }))
              }
            >
              {busy ? (
                <Busy label="Stopping" />
              ) : (
                <>
                  <Square size={16} />
                  {s?.state === "starting" ? "Cancel" : "Stop capture"}
                </>
              )}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || !running}
              onClick={() =>
                void act(() =>
                  request("fpsStart", { gameId: selected, confirmed: true }),
                )
              }
            >
              <Play size={16} />
              Start FPS capture
            </Button>
          )}
        </div>
      )}
      {!active && games.length > 0 && !running && (
        <p className="mon-note">Start the game first; it is not running now.</p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {s?.state === "starting" && (
        <p role="status">
          <Busy label="Waiting for Windows administrator approval" />
        </p>
      )}
      {s && (s.state === "capturing" || s.state === "ended") && (
        <div className="fps-live">
          <div className="fps-hero">
            <div>
              <span className="label">
                {s.state === "capturing" ? "FPS now" : "Last second"}
              </span>
              <div className="stat-value xl mon-value">{fpsText(s.fps)}</div>
            </div>
            <div>
              <span className="label">Average</span>
              <div className="stat-value mon-value">{fpsText(s.avgFps)}</div>
            </div>
            <div title="Average FPS of the slowest 1% of frames">
              <span className="label">1% low</span>
              <div className="stat-value mon-value">{fpsText(s.low1Fps)}</div>
            </div>
            <div>
              <span className="label">Frames</span>
              <div className="stat-value mon-value">
                {s.frames.toLocaleString()}
              </div>
            </div>
            <div>
              <span className="label">Time</span>
              <div className="stat-value mon-value">
                {duration(s.elapsedSeconds)}
              </div>
            </div>
          </div>
          <div className="mon-two">
            <div>
              <span className="label">
                Frame time (ms), last {s.frameTimes.length} frames
              </span>
              <AreaChart
                values={s.frameTimes}
                max={peak}
                slots={240}
                tone="info"
                label={`Frame time, latest ${s.frameTimes.at(-1)?.toFixed(1) ?? "none"} ms`}
                tick={s.frames}
              />
            </div>
            <div>
              <span className="label">FPS per second</span>
              <AreaChart
                values={s.fpsHistory}
                max={fpsPeak}
                slots={120}
                label={`FPS, latest ${fpsText(s.fps)}`}
                tick={s.elapsedSeconds}
              />
            </div>
          </div>
          <div className="fps-usage">
            <span className="label">{s.gameName ?? "Game"}</span>
            {s.usage ? (
              <span className="mono">
                CPU {percent(s.usage.cpuPercent)} / Memory{" "}
                {formatSize(s.usage.workingSetBytes)} / GPU{" "}
                {s.usage.gpuPercent === null
                  ? "n/a"
                  : percent(s.usage.gpuPercent)}
              </span>
            ) : (
              <span className="muted">Usage is read once a second.</span>
            )}
            <Badge tone="neutral">{boostText[s.boost]}</Badge>
          </div>
        </div>
      )}
      {s && s.state !== "idle" && s.detail && (
        <p
          className={
            s.state === "unavailable" || s.code === "no-frames"
              ? "notice-text"
              : "mon-note"
          }
          role="status"
        >
          {s.detail}
        </p>
      )}
      {selected && (
        <FpsHistory gameId={selected} key={s?.saved?.id ?? "none"} />
      )}
    </Panel>
  );
}
