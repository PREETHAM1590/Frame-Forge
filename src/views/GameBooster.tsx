import { useCallback, useEffect, useState } from "react";
import {
  Gamepad2,
  Play,
  Square,
  Info,
  ArrowUpRight,
  RotateCcw,
  Plus,
  Trash2,
  ListRestart,
} from "lucide-react";
import { PageTitle, Button, Badge, Empty, Toggle } from "../components/ui";
import { desktopOnly, onEvent, request } from "../api";
import {
  modeMechanisms,
  type BoostMode,
  type BoostSession,
  type BoosterConfig,
  type CustomMechanisms,
  type MechanismId,
  type MechanismResult,
  type Response,
  type RunningProcess,
} from "../../shared/contracts";
import type { ViewProps } from "../types";
const modes: { id: BoostMode; label: string; summary: string }[] = [
  { id: "off", label: "Off", summary: "Frameforge changes nothing." },
  {
    id: "balanced",
    label: "Balanced",
    summary: "Windows Game Mode and Above normal game priority.",
  },
  {
    id: "performance",
    label: "Performance",
    summary:
      "Adds High priority, a performance power plan and lowers selected background apps.",
  },
  {
    id: "competitive",
    label: "Competitive",
    summary:
      "Adds suspending selected background apps and a finer timer where Windows supports it.",
  },
  {
    id: "custom",
    label: "Custom",
    summary: "Choose each mechanism yourself.",
  },
];
const labels: Record<MechanismId, string> = {
  gameMode: "Windows Game Mode",
  priority: "Game priority",
  affinity: "Game CPU affinity",
  powerPlan: "Performance power plan",
  lowerBackground: "Lower background apps",
  suspendBackground: "Suspend background apps",
  closeBackground: "Close background apps",
  timerResolution: "High timer resolution",
  standbyPurge: "Standby list purge",
};
const tones: Record<
  MechanismResult["state"],
  "lime" | "amber" | "red" | "neutral" | "cyan"
> = {
  applied: "lime",
  reverted: "cyan",
  skipped: "neutral",
  unsupported: "amber",
  unavailable: "amber",
  conflict: "amber",
  failed: "red",
};
const statusTones = {
  preparing: "amber",
  active: "lime",
  restoring: "amber",
  "recovery-needed": "red",
  ended: "neutral",
} as const;
type Entry = { id: MechanismId; note?: string };
function enabled(m: CustomMechanisms): Entry[] {
  const list: (Entry | false)[] = [
    m.gameMode && { id: "gameMode" },
    m.priority !== "Normal" && {
      id: "priority",
      note: m.priority === "High" ? "High" : "Above normal",
    },
    !!m.affinity?.length && {
      id: "affinity",
      note: `${m.affinity.length} CPUs`,
    },
    m.powerPlan && { id: "powerPlan" },
    m.lowerBackground && { id: "lowerBackground" },
    m.suspendBackground && { id: "suspendBackground" },
    m.closeBackground && { id: "closeBackground", note: "not reopened" },
    m.timerResolution && { id: "timerResolution" },
  ];
  return list.filter((x): x is Entry => !!x);
}
type Status = Response<"boostStatus">;
export function GameMode({ data, run, pending, navigate }: ViewProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const [processes, setProcesses] = useState<RunningProcess[] | null>(null);
  const [pick, setPick] = useState("");
  const [pickAction, setPickAction] = useState<"lower" | "suspend" | "close">(
    "lower",
  );
  const [gameId, setGameId] = useState(data.state.games[0]?.id ?? "");
  const [now, setNow] = useState(0);
  const refresh = useCallback(
    () =>
      request("boostStatus", {})
        .then(setStatus)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh, data]);
  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "boost") return;
        const s = event.session;
        setStatus((old) =>
          old ? { ...old, session: s.status === "ended" ? null : s } : old,
        );
        setLog((lines) =>
          [...lines, `${new Date().toLocaleTimeString()}  ${s.message}`].slice(
            -60,
          ),
        );
        if (s.status === "ended" || s.status === "recovery-needed")
          setOutcome({ text: s.message, error: s.status !== "ended" });
      }),
    [],
  );
  const session: BoostSession | null = status
    ? status.session
    : data.boost.session;
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session]);
  const config = data.state.booster;
  const caps = status?.capabilities;
  const cap = (id: MechanismId) => caps?.mechanisms.find((m) => m.id === id);
  const available = data.boost.available;
  const unavailable =
    data.mode === "demo"
      ? desktopOnly
      : !available
        ? "The Windows helper is missing, so the game booster is unavailable."
        : "";
  const save = (next: Partial<BoosterConfig>) =>
    run("boostConfig", { ...config, ...next }, "Game booster settings saved.");
  const setCustom = (next: Partial<CustomMechanisms>) =>
    save({ custom: { ...config.custom, ...next } });
  const mechanisms =
    config.mode === "custom" ? config.custom : modeMechanisms[config.mode];
  const game = data.state.games.find((g) => g.id === gameId);
  const gameMode = game
    ? game.boostMode === "global"
      ? config.mode
      : game.boostMode
    : config.mode;
  const sessionGame = data.state.games.find((g) => g.id === session?.gameId);
  const cpus = Math.min(caps?.logicalCpus ?? 0, 64);
  const startReason =
    unavailable ||
    (session
      ? "Stop or recover the current session first."
      : !game
        ? "Choose a game first."
        : gameMode === "off"
          ? `Booster mode is Off for ${game.name}.`
          : pending
            ? "Wait for the current request."
            : "");
  const sample = session?.samples.at(-1);
  const minutes =
    session && now
      ? Math.max(0, Math.floor((now - Date.parse(session.startedAt)) / 60000))
      : null;
  return (
    <>
      <PageTitle
        title="Game Mode"
        subtitle="Selectable boost modes. Every change is saved first and restored when the game exits."
        action={
          <Badge tone={session ? statusTones[session.status] : "neutral"}>
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
      <p className="muted">
        Frameforge does not measure FPS. Session CPU/RAM snapshots are shown for
        reference.
      </p>
      {outcome && (
        <p
          className="notice"
          role={outcome.error ? "alert" : "status"}
          data-error={outcome.error}
        >
          {outcome.text}
        </p>
      )}
      {session?.status === "recovery-needed" && (
        <div className="notice" role="alert">
          <RotateCcw size={18} />
          <div>
            <p>{session.message}</p>
            <div className="dialog-actions">
              <Button
                variant="primary"
                disabled={pending || !available}
                title={unavailable || undefined}
                onClick={async () => {
                  const result = await run("boostRecover", { confirmed: true });
                  if (result)
                    setOutcome({
                      text: result.message,
                      error: result.status !== "ended",
                    });
                }}
              >
                <RotateCcw size={17} /> Retry recovery
              </Button>
              <Button
                disabled={pending}
                title="Stop retrying and keep the current Windows state as it is."
                onClick={async () => {
                  const result = await run("boostRecover", {
                    confirmed: true,
                    dismiss: true,
                  });
                  if (result)
                    setOutcome({ text: result.message, error: false });
                }}
              >
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      )}
      {session && session.status !== "recovery-needed" && (
        <section className="session-surface" aria-label="Boost session">
          <h2>{sessionGame?.name ?? "Boosted game"}</h2>
          <p className="muted" role="status">
            {session.message}
          </p>
          <div className="session-details">
            <span>
              Mode
              <strong>{modes.find((m) => m.id === session.mode)?.label}</strong>
            </span>
            <span>
              Uptime
              <strong>{minutes === null ? "-" : `${minutes} min`}</strong>
            </span>
            <span>
              System snapshot (not FPS)
              <strong>
                {sample
                  ? `CPU ${sample.systemCpuPercent.toFixed(0)}%, free RAM ${(sample.availableMemoryBytes / 1024 ** 3).toFixed(1)} GB, game ${(sample.gameWorkingSetBytes / 1024 ** 2).toFixed(0)} MB`
                  : "First sample after 30 s"}
              </strong>
            </span>
          </div>
          <ul className="booster-chips" aria-label="Mechanism results">
            {session.mechanisms.map((m, i) => (
              <li key={i} title={m.detail}>
                <Badge tone={tones[m.state]}>
                  {labels[m.id]}: {m.state}
                </Badge>
              </li>
            ))}
          </ul>
          <Button
            variant="primary"
            disabled={
              pending ||
              session.status === "preparing" ||
              session.status === "restoring"
            }
            title={
              session.status === "preparing" || session.status === "restoring"
                ? "Wait for the session to finish its current step."
                : undefined
            }
            onClick={async () => {
              const result = await run("boostStop", { confirmed: true });
              if (result !== undefined)
                setOutcome(
                  result
                    ? {
                        text: result.message,
                        error: result.status !== "ended",
                      }
                    : { text: "No boost session was running.", error: false },
                );
            }}
          >
            <Square size={17} /> Stop and restore
          </Button>
        </section>
      )}
      <section className="booster-section" aria-label="Boost mode">
        <h2>Mode</h2>
        <div className="tabs" role="group" aria-label="Boost mode">
          {modes.map((m) => (
            <button
              key={m.id}
              className={config.mode === m.id ? "active" : ""}
              aria-pressed={config.mode === m.id}
              disabled={pending}
              onClick={() => void save({ mode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="muted">
          {modes.find((m) => m.id === config.mode)?.summary} Games set to “Use
          global” in the library use this mode.
        </p>
        <ul className="mechanism-list">
          {enabled(mechanisms).map(({ id, note }) => {
            const c = cap(id);
            return (
              <li key={id}>
                <span>
                  {labels[id]}
                  {note ? ` (${note})` : ""}
                </span>
                <Badge tone={c?.available ? "lime" : "amber"}>
                  {c
                    ? c.available
                      ? "available"
                      : "unsupported here"
                    : "checking"}
                </Badge>
                {c && !c.available && (
                  <small className="muted">{c.detail}</small>
                )}
              </li>
            );
          })}
          <li>
            <span>{labels.standbyPurge}</span>
            <Badge tone="amber">unsupported</Badge>
            <small className="muted">
              {cap("standbyPurge")?.detail ??
                "Needs administrator rights and SeProfileSingleProcessPrivilege."}
            </small>
          </li>
        </ul>
      </section>
      {config.mode === "custom" && (
        <section className="booster-section" aria-label="Custom mechanisms">
          <h2>Custom mechanisms</h2>
          <Toggle
            label="Windows Game Mode"
            description="Turns on the current-user Game Mode values and restores them afterwards."
            checked={config.custom.gameMode}
            disabled={pending}
            onChange={(v) => void setCustom({ gameMode: v })}
          />
          <label className="field">
            Game priority
            <select
              value={config.custom.priority}
              disabled={pending}
              onChange={(e) =>
                void setCustom({
                  priority: e.target.value as CustomMechanisms["priority"],
                })
              }
            >
              <option value="Normal">Normal (unchanged)</option>
              <option value="AboveNormal">Above normal</option>
              <option value="High">High</option>
            </select>
          </label>
          <Toggle
            label="Performance power plan"
            description={
              cap("powerPlan")?.available === false
                ? `Unavailable: ${cap("powerPlan")!.detail}`
                : "Switches to High performance (or Ultimate, if present) and back."
            }
            checked={config.custom.powerPlan}
            disabled={pending}
            onChange={(v) => void setCustom({ powerPlan: v })}
          />
          <Toggle
            label="Lower background apps"
            description="Selected apps run at Below normal during the session."
            checked={config.custom.lowerBackground}
            disabled={pending}
            onChange={(v) => void setCustom({ lowerBackground: v })}
          />
          <Toggle
            label="Suspend background apps"
            description="Selected apps are paused during the session and resumed afterwards."
            checked={config.custom.suspendBackground}
            disabled={pending}
            onChange={(v) => void setCustom({ suspendBackground: v })}
          />
          <Toggle
            label="Close background apps"
            description="Selected apps are closed. They are not reopened after the session."
            checked={config.custom.closeBackground}
            disabled={pending}
            onChange={(v) => void setCustom({ closeBackground: v })}
          />
          <Toggle
            label="High timer resolution"
            description={
              cap("timerResolution")?.available === false
                ? `Unsupported: ${cap("timerResolution")!.detail}`
                : "Requests a 0.5 ms timer while the game runs. Uses more power."
            }
            checked={config.custom.timerResolution}
            disabled={pending || cap("timerResolution")?.available === false}
            onChange={(v) => void setCustom({ timerResolution: v })}
          />
          <Toggle
            label="Limit game to selected CPUs"
            description={
              cpus
                ? "Some games run worse with fewer cores. Test before relying on it."
                : "The CPU count is unknown until the desktop helper responds."
            }
            checked={config.custom.affinity !== null}
            disabled={pending || !cpus}
            onChange={(v) =>
              void setCustom({
                affinity: v ? Array.from({ length: cpus }, (_, i) => i) : null,
              })
            }
          />
          {config.custom.affinity && cpus > 0 && (
            <fieldset className="cpu-grid">
              <legend>Logical CPUs</legend>
              {Array.from({ length: cpus }, (_, i) => (
                <label key={i}>
                  <input
                    type="checkbox"
                    checked={config.custom.affinity!.includes(i)}
                    disabled={pending}
                    onChange={(e) =>
                      void setCustom({
                        affinity: e.target.checked
                          ? [...config.custom.affinity!, i].sort(
                              (a, b) => a - b,
                            )
                          : config.custom.affinity!.filter((c) => c !== i),
                      })
                    }
                  />
                  CPU {i}
                </label>
              ))}
            </fieldset>
          )}
        </section>
      )}
      <section className="booster-section" aria-label="Background apps">
        <h2>Background apps</h2>
        <p className="muted">
          Apps in your own session only. System, security and anti-cheat
          processes are protected and cannot be selected.
        </p>
        <ul className="mechanism-list">
          {config.background.map((entry, index) => (
            <li key={entry.image}>
              <span>{entry.image}</span>
              <select
                aria-label={`Action for ${entry.image}`}
                value={entry.action}
                disabled={pending}
                onChange={(e) =>
                  void save({
                    background: config.background.map((b, i) =>
                      i === index
                        ? { ...b, action: e.target.value as typeof b.action }
                        : b,
                    ),
                  })
                }
              >
                <option value="lower">Lower priority</option>
                <option value="suspend">Suspend</option>
                <option value="close">Close (not reopened)</option>
              </select>
              <button
                className="icon-button"
                aria-label={`Remove ${entry.image}`}
                title={`Remove ${entry.image}`}
                disabled={pending}
                onClick={() =>
                  void save({
                    background: config.background.filter((_, i) => i !== index),
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
        <div className="toolbar">
          <Button
            disabled={pending || !!unavailable}
            title={unavailable || "Read the apps running in your session."}
            onClick={async () => {
              const found = await run("runningProcesses", {});
              if (found) setProcesses(found);
            }}
          >
            <ListRestart size={17} /> Load running apps
          </Button>
          {processes && (
            <>
              <select
                aria-label="Running app"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                <option value="">Choose an app</option>
                {[
                  ...new Map(
                    processes.map((p) => [p.image.toLowerCase(), p]),
                  ).values(),
                ]
                  .filter(
                    (p) =>
                      /^[\w .()-]{1,64}\.exe$/i.test(p.image) &&
                      !config.background.some(
                        (b) => b.image.toLowerCase() === p.image.toLowerCase(),
                      ),
                  )
                  .map((p) => (
                    <option
                      key={p.image}
                      value={p.image}
                      disabled={p.protected}
                    >
                      {p.image}
                      {p.protected ? " (protected)" : ""}
                    </option>
                  ))}
              </select>
              <select
                aria-label="Action"
                value={pickAction}
                onChange={(e) =>
                  setPickAction(e.target.value as typeof pickAction)
                }
              >
                <option value="lower">Lower priority</option>
                <option value="suspend">Suspend</option>
                <option value="close">Close (not reopened)</option>
              </select>
              <Button
                disabled={pending || !pick || config.background.length >= 50}
                title={!pick ? "Choose an app first." : undefined}
                onClick={async () => {
                  if (
                    await save({
                      background: [
                        ...config.background,
                        { image: pick, action: pickAction },
                      ],
                    })
                  )
                    setPick("");
                }}
              >
                <Plus size={17} /> Add
              </Button>
            </>
          )}
        </div>
        <Toggle
          label="Auto-boost when a library game starts"
          description={
            unavailable ||
            `Checks every 5 seconds for a running library game and starts its mode.${status?.watching ? " Watching now." : ""}`
          }
          checked={config.autoBoost}
          disabled={pending || !!unavailable}
          onChange={(v) => void save({ autoBoost: v })}
        />
      </section>
      <section className="booster-section" aria-label="Start a boost">
        <h2>Boost a running game</h2>
        {data.state.games.length ? (
          <>
            <label className="field">
              Game
              <select
                value={gameId}
                disabled={!!session}
                onChange={(e) => setGameId(e.target.value)}
              >
                {data.state.games.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              Mode for this game: {modes.find((m) => m.id === gameMode)?.label}
              {game?.boostMode === "global" ? " (global)" : ""}. Start the game
              first.
            </p>
            <Button
              variant="primary"
              disabled={!!startReason}
              title={startReason || undefined}
              onClick={async () => {
                const result = await run("boostStart", {
                  gameId,
                  confirmed: true,
                });
                if (result)
                  setOutcome({
                    text: result.message,
                    error: result.status !== "active",
                  });
              }}
            >
              <Play size={17} /> Start boost
            </Button>
            {startReason && <p className="muted">{startReason}</p>}
          </>
        ) : (
          <Empty
            title="Add a game first"
            description="A game in your library is needed to boost it."
            action={
              <Button onClick={() => navigate("Game library")}>
                Open game library
                <ArrowUpRight size={17} />
              </Button>
            }
          />
        )}
      </section>
      {log.length > 0 && (
        <section className="booster-section" aria-label="Session log">
          <h2>
            <Gamepad2 size={18} /> Session log
          </h2>
          <ol className="booster-log" aria-live="polite">
            {log.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
