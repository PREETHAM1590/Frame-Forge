import { useCallback, useEffect, useState } from "react";
import { Play, Save, Square, Trash2 } from "lucide-react";
import { Badge, Busy, Button, Panel, SectionHeader } from "../../components/ui";
import { onEvent, request } from "../../api";
import {
  compareBench,
  noiseNote,
  recommendedRuns,
  usable,
  verdictLabel,
  type Row,
} from "../../../shared/benchmark";
import type {
  Bootstrap,
  FpsStatus,
  FpsSummary,
  BenchReport,
} from "../../../shared/contracts";

type Data = { runs: FpsSummary[]; reports: BenchReport[] };
const lengths = [60, 90, 120];
const verdictTone = {
  better: "lime",
  worse: "red",
  changed: "amber",
  none: "neutral",
  insufficient: "neutral",
} as const;

function Cell({ row, side }: { row: Row; side: "off" | "on" }) {
  const s = row[side];
  if (!s) return <>n/a</>;
  const d = row.metric.digits;
  return (
    <>
      {s.mean.toFixed(d)}{" "}
      <span className="muted">
        (sd {s.stdev.toFixed(d)}, {s.min.toFixed(d)} to {s.max.toFixed(d)}, n=
        {s.n})
      </span>
    </>
  );
}

export function ResultTable({ runs }: { runs: FpsSummary[] }) {
  const r = compareBench(runs);
  return (
    <div className="bench-result">
      <p role="status">
        <strong>{r.headline}</strong>
      </p>
      {r.warnings.map((w) => (
        <p key={w} className="notice-text">
          {w}
        </p>
      ))}
      <table className="mon-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Game Mode off</th>
            <th scope="col">Game Mode on</th>
            <th scope="col">Difference</th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row) => (
            <tr key={row.metric.key}>
              <td>{row.metric.label}</td>
              <td>
                <Cell row={row} side="off" />
              </td>
              <td>
                <Cell row={row} side="on" />
              </td>
              <td>
                {row.delta === null
                  ? "n/a"
                  : `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(row.metric.digits)} ${row.metric.unit}`}
              </td>
              <td>
                <Badge tone={verdictTone[row.verdict]}>
                  {verdictLabel(row.verdict)}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mon-note">{noiseNote}</p>
    </div>
  );
}

/** Guided A/B test: timed runs with Game Mode off and on, compared against their own run-to-run spread. */
export function Benchmark({ data }: { data: Bootstrap }) {
  const games = data.state.games;
  const [gameId, setGameId] = useState(games[0]?.id ?? "");
  const [seconds, setSeconds] = useState(60);
  const [want, setWant] = useState<"off" | "on">("off");
  const [status, setStatus] = useState<FpsStatus | null>(null);
  const [boostGame, setBoostGame] = useState<string | null>(
    data.boost.session?.status === "active" ? data.boost.session.gameId : null,
  );
  const [bench, setBench] = useState<Data>({ runs: [], reports: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    if (!gameId) return;
    request("benchData", { gameId })
      .then(setBench)
      .catch(() => setBench({ runs: [], reports: [] }));
  }, [gameId]);
  useEffect(load, [load]);
  useEffect(() => {
    request("fpsStatus", {})
      .then(setStatus)
      .catch(() => setStatus(null));
    return onEvent((e) => {
      if (e.type === "fps") {
        setStatus(e.status);
        if (e.status.state === "ended") load();
      }
      if (e.type === "boost")
        setBoostGame(e.session.status === "active" ? e.session.gameId : null);
    });
  }, [load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };
  const active = status?.state === "starting" || status?.state === "capturing";
  const running = status?.running.includes(gameId) ?? false;
  const boosted = boostGame === gameId;
  const mismatch =
    want === "off" && boosted
      ? 'Game Mode is active for this game. Stop the session on the Game Mode page for the "off" runs.'
      : want === "on" && !boosted
        ? 'Start Game Mode for this game on the Game Mode page before the "on" runs.'
        : "";
  const left =
    status?.state === "capturing" && status.benchmarkSeconds
      ? Math.max(0, status.benchmarkSeconds - status.elapsedSeconds)
      : null;
  const hasRuns = bench.runs.length > 0;
  if (!games.length) return null;

  return (
    <Panel aria-label="Benchmark">
      <SectionHeader
        level={3}
        title="Benchmark: Game Mode off vs on"
        icon={<Play size={18} />}
      />
      <p className="muted">
        Play the same scene for {seconds} s per run. Do at least 3 runs with
        Game Mode off and 3 with it on ({recommendedRuns} each is better). Every
        run opens one Windows administrator prompt unless Frameforge already
        runs as administrator. Frameforge reports only what it measures.
      </p>
      <div className="fps-controls">
        <label>
          Game{" "}
          <select
            value={gameId}
            disabled={active}
            onChange={(e) => setGameId(e.target.value)}
          >
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {status?.running.includes(g.id) ? " (running)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Run length{" "}
          <select
            value={seconds}
            disabled={active}
            onChange={(e) => setSeconds(Number(e.target.value))}
          >
            {lengths.map((l) => (
              <option key={l} value={l}>
                {l} s
              </option>
            ))}
          </select>
        </label>
        <label>
          Next run{" "}
          <select
            value={want}
            disabled={active}
            onChange={(e) => setWant(e.target.value as "off" | "on")}
          >
            <option value="off">Without Game Mode (off)</option>
            <option value="on">With Game Mode (on)</option>
          </select>
        </label>
        {active ? (
          <Button
            disabled={busy}
            onClick={() =>
              void act(() => request("fpsStop", { confirmed: true }))
            }
          >
            <Square size={16} /> Stop run (too short runs are left out)
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy || !running || !!mismatch}
            onClick={() =>
              void act(() =>
                request("fpsStart", {
                  gameId,
                  confirmed: true,
                  benchmarkSeconds: seconds,
                }),
              )
            }
          >
            <Play size={16} /> Start {want === "on" ? "boosted" : "unboosted"}{" "}
            run
          </Button>
        )}
      </div>
      {!active && !running && (
        <p className="mon-note">
          The selected game is not running; start it first.
        </p>
      )}
      {!active && mismatch && <p className="notice-text">{mismatch}</p>}
      {status?.state === "starting" && (
        <p role="status">
          <Busy label="Waiting for Windows administrator approval" />
        </p>
      )}
      {left !== null && (
        <p role="timer" className="stat-value">
          {left} s left{" "}
          <span className="muted">
            Play the same scene.{" "}
            {status?.fps ? `${Math.round(status.fps)} FPS` : ""}
          </span>
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {hasRuns && (
        <>
          <table className="mon-table">
            <caption className="label">Runs in this set</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Game Mode</th>
                <th scope="col">Average</th>
                <th scope="col">1% low</th>
                <th scope="col">Length</th>
                <th scope="col">Counted</th>
              </tr>
            </thead>
            <tbody>
              {[...bench.runs].reverse().map((r, i) => (
                <tr key={r.id}>
                  <td>{i + 1}</td>
                  <td>{r.boost}</td>
                  <td>{r.avgFps.toFixed(1)}</td>
                  <td>{r.low1Fps?.toFixed(1) ?? "n/a"}</td>
                  <td>{r.durationSeconds} s</td>
                  <td>{usable(r) ?? "yes"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ResultTable runs={bench.runs} />
          <div className="dialog-actions">
            <Button
              variant="primary"
              disabled={busy || active}
              onClick={() =>
                void act(async () => {
                  setBench(await request("benchSave", { gameId }));
                  setNotice("Report saved. Export it below.");
                })
              }
            >
              <Save size={16} /> Save report and start a new set
            </Button>
            <Button
              disabled={busy || active}
              onClick={() =>
                void act(async () =>
                  setBench(
                    await request("benchDiscard", { gameId, confirmed: true }),
                  ),
                )
              }
            >
              <Trash2 size={16} /> Discard these runs
            </Button>
          </div>
        </>
      )}
      {bench.reports.length > 0 && (
        <div className="bench-reports">
          <span className="label">Saved reports</span>
          <ul>
            {bench.reports.map((r) => (
              <li key={r.id}>
                {new Date(r.at).toLocaleString()} ({r.runs.length} runs){" "}
                {(["md", "csv"] as const).map((format) => (
                  <Button
                    key={format}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const path = await request("benchExport", {
                          reportId: r.id,
                          format,
                        });
                        setNotice(
                          path ? `Saved to ${path}` : "Export cancelled.",
                        );
                      })
                    }
                  >
                    Export {format === "md" ? "Markdown" : "CSV"}
                  </Button>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
