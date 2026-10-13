import { useCallback, useEffect, useRef, useState } from "react";
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
  Wifi,
} from "lucide-react";
import {
  PageTitle,
  Button,
  Badge,
  Empty,
  Toggle,
  Modal,
} from "../components/ui";
import { desktopOnly, onEvent, request } from "../api";
import {
  modeMechanisms,
  type LaunchPreview,
  type LaunchSetting,
  type LaunchStatus,
  type BoostMode,
  type BoostSession,
  type BoosterConfig,
  type CustomMechanisms,
  type MechanismId,
  type MechanismResult,
  type NetworkCheck,
  type Response,
  type RunningProcess,
} from "../../shared/contracts";
import type { ViewProps } from "../types";
const modes: { id: BoostMode; label: string; summary: string }[] = [
  { id: "off", label: "Off", summary: "Frameforge changes nothing." },
  {
    id: "balanced",
    label: "Balanced",
    summary:
      "Windows Game Mode, Above normal game priority, Game Bar capture off for the session and a power-throttling opt-out for the game.",
  },
  {
    id: "performance",
    label: "Performance",
    summary:
      "Adds High priority, a performance power plan, lowering selected background apps and, on Windows 10 hybrid CPUs, steering the game to the performance cores. On Windows 11 the CPU scheduler already does that, so it stays off.",
  },
  {
    id: "competitive",
    label: "Competitive",
    summary:
      "Adds suspending selected background apps, a finer timer where Windows supports it, plugged-in core unparking (on hybrid CPUs including the performance-core setting) and pausing a short list of safe Windows services (Windows asks for administrator approval at the start and at the end).",
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
  pauseServices: "Pause Windows services",
  gameBarCapture: "Game Bar capture off",
  smartCores: "Smart core targeting",
  coreParking: "Disable core parking",
  powerThrottling: "Power throttling opt-out",
};
const launchLabels = {
  gpuPreference: "High-performance GPU preference",
  fullscreenOptimizations: "Fullscreen optimizations off (advanced)",
} as const;
// Mechanisms whose "can't do it here" state is a property of this PC or Windows build, not a missing prerequisite.
const unsupportedWhenUnavailable = new Set<MechanismId>([
  "timerResolution",
  "smartCores",
  "coreParking",
  "powerThrottling",
]);
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
    m.powerThrottling && { id: "powerThrottling" },
    m.gameBarCapture && { id: "gameBarCapture" },
    m.smartCores && { id: "smartCores" },
    m.coreParking && { id: "coreParking" },
    m.pauseServices && { id: "pauseServices", note: "administrator prompt" },
  ];
  return list.filter((x): x is Entry => !!x);
}
type Capability = Response<"boostStatus">["capabilities"]["mechanisms"][number];
type Background = BoosterConfig["background"];
const actionOf: Partial<Record<MechanismId, Background[number]["action"]>> = {
  lowerBackground: "lower",
  suspendBackground: "suspend",
  closeBackground: "close",
};
// What a mechanism will really do on this PC, so modes show their actual difference.
function onThisPc(
  { id, note }: Entry,
  cap: Capability | undefined,
  background: Background,
  // preset: a preset mode card; threadDirector: a hybrid CPU on Windows 11.
  ctx: { preset: boolean; threadDirector: boolean } = {
    preset: false,
    threadDirector: false,
  },
): { tone: "lime" | "amber" | "neutral"; label: string; reason: string } {
  const action = actionOf[id];
  if (action) {
    const apps = background.filter((b) => b.action === action);
    return apps.length
      ? {
          tone: "lime",
          label: "applies",
          reason: apps.map((b) => b.image).join(", "),
        }
      : {
          tone: "amber",
          label: "not configured",
          reason: "No apps picked yet. Add them under Background apps.",
        };
  }
  if (!cap) return { tone: "neutral", label: "checking", reason: "" };
  if (!cap.available)
    return {
      tone: "amber",
      label: unsupportedWhenUnavailable.has(id) ? "unsupported" : "unavailable",
      reason: cap.detail,
    };
  if (id === "smartCores" && ctx.preset && ctx.threadDirector)
    return {
      tone: "neutral",
      label: "off by default here",
      reason:
        "Windows 11's Thread Director already places games on the performance cores. Turn it on under Custom to force it.",
    };
  if (cap.active)
    return { tone: "neutral", label: "already on", reason: cap.detail };
  return {
    tone: "lime",
    label: id === "pauseServices" ? "applies (asks for admin)" : "applies",
    reason:
      id === "priority"
        ? `${note}; skipped if the game already runs higher.`
        : id === "pauseServices"
          ? cap.detail
          : (note ?? cap.detail),
  };
}
const referenceTargets = [
  { host: "1.1.1.1", label: "Cloudflare DNS" },
  { host: "8.8.8.8", label: "Google DNS" },
  { host: "9.9.9.9", label: "Quad9 DNS" },
];
const hostPattern =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9A-Fa-f:.]+)$/;
// Suggested background apps; voice chat, capture and launchers are never suggested.
const suggestions: [RegExp, Background[number]["action"], string][] = [
  [
    /^(chrome|msedge|firefox|opera|opera_gx|brave|vivaldi)\.exe$/i,
    "lower",
    "browser",
  ],
  [
    /^(onedrive|dropbox|googledrivefs|megasync|icloud\w*)\.exe$/i,
    "suspend",
    "cloud sync",
  ],
  [/updat/i, "suspend", "updater"],
];
const neverSuggest =
  /^(discord|teamspeak|ts3client|mumble|skype|teams|ms-teams|zoom|slack|obs|steam|epicgameslauncher|galaxyclient)/i;
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
  const [confirmPlan, setConfirmPlan] = useState(false);
  const [confirmServices, setConfirmServices] = useState(false);
  const [netHost, setNetHost] = useState("");
  const [netBusy, setNetBusy] = useState(false);
  const [netResult, setNetResult] = useState<NetworkCheck | null>(null);
  const [netError, setNetError] = useState("");
  const [launch, setLaunch] = useState<LaunchStatus | null>(null);
  const [launchError, setLaunchError] = useState("");
  const [launchDialog, setLaunchDialog] = useState<{
    setting: LaunchSetting;
    action: "apply" | "revert" | "forget";
    preview: LaunchPreview | null;
  } | null>(null);
  // Mechanism results already logged for the current session (events carry the whole session).
  const logged = useRef({ id: "", last: "", status: "" });
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
  const launchGameId = gameId;
  useEffect(() => {
    if (!launchGameId || data.mode === "demo") return;
    let current = true;
    request("launchSettings", { gameId: launchGameId })
      .then((status) => {
        if (!current) return;
        setLaunch(status);
        setLaunchError("");
      })
      .catch((error: unknown) => {
        if (!current) return;
        setLaunch(null);
        setLaunchError(
          error instanceof Error ? error.message : "Launch settings failed.",
        );
      });
    return () => {
      current = false;
    };
  }, [launchGameId, data]);
  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "boost") return;
        const s = event.session;
        setStatus((old) =>
          old ? { ...old, session: s.status === "ended" ? null : s } : old,
        );
        const seen =
          logged.current.id === s.id
            ? logged.current
            : { id: s.id, last: "", status: "" };
        // New results follow the last one logged; this still works once the list is capped at 400 entries.
        const keys = s.mechanisms.map((m) => JSON.stringify(m));
        const from = seen.last ? keys.lastIndexOf(seen.last) + 1 : 0;
        const time = new Date().toLocaleTimeString();
        const lines = s.mechanisms
          .slice(from)
          .map((m) => `${time}  ${labels[m.id]}: ${m.state}. ${m.detail}`);
        if (s.status !== seen.status) lines.push(`${time}  ${s.message}`);
        logged.current = {
          id: s.id,
          last: keys.at(-1) ?? seen.last,
          status: s.status,
        };
        if (lines.length) setLog((old) => [...old, ...lines].slice(-80));
        if (s.status === "ended" || s.status === "recovery-needed")
          setOutcome({
            text: s.message,
            error: s.status !== "ended" || s.failed,
          });
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
  const modeName = (id: BoostMode) =>
    modes.find((m) => m.id === id)?.label ?? id;
  const suggested = processes
    ? [
        ...new Map(
          processes
            .filter(
              (p) =>
                !p.protected &&
                /^[\w .()-]{1,64}\.exe$/i.test(p.image) &&
                !neverSuggest.test(p.image) &&
                !config.background.some(
                  (b) => b.image.toLowerCase() === p.image.toLowerCase(),
                ),
            )
            .map((p) => [p.image.toLowerCase(), p.image]),
        ).values(),
      ]
        .flatMap((image) => {
          const match = suggestions.find(([pattern]) => pattern.test(image));
          return match ? [{ image, action: match[1], kind: match[2] }] : [];
        })
        .slice(0, 12)
    : [];
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
  // Whether the boost about to start will pause services: that is the one step that opens an administrator prompt.
  const gameMechanisms =
    gameMode === "off"
      ? null
      : gameMode === "custom"
        ? config.custom
        : modeMechanisms[gameMode];
  const willPauseServices =
    !!gameMechanisms?.pauseServices && cap("pauseServices")?.available === true;
  const startBoost = async () => {
    const result = await run("boostStart", {
      gameId,
      confirmed: true,
    });
    if (result)
      setOutcome({
        text: result.message,
        error: result.status !== "active",
      });
  };
  const hostTrimmed = netHost.trim();
  const hostValid =
    hostTrimmed.length > 0 &&
    hostTrimmed.length <= 253 &&
    hostPattern.test(hostTrimmed);
  const checkNetwork = async (host: string) => {
    setNetBusy(true);
    setNetError("");
    setNetResult(null);
    try {
      setNetResult(await request("networkCheck", { host, count: 10 }));
    } catch (error) {
      setNetError(
        error instanceof Error ? error.message : "The network check failed.",
      );
    } finally {
      setNetBusy(false);
    }
  };
  const sample = session?.samples.at(-1);
  const minutes =
    session && now
      ? Math.max(0, Math.floor((now - Date.parse(session.startedAt)) / 60000))
      : null;
  return (
    <>
      <PageTitle
        title="Game Mode"
        subtitle="Selectable boost modes. Reversible changes are saved first and restored when the game exits; closed apps are not reopened."
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
                      error: result.status !== "ended" || result.failed,
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
                    setOutcome({ text: result.message, error: result.failed });
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
                        error: result.status !== "ended" || result.failed,
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
              title={pending ? "Wait for the current request." : m.summary}
              onClick={() => void save({ mode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="muted">
          {modes.find((m) => m.id === config.mode)?.summary} Games set to “Use
          global” in the library use this mode. The cards show what each mode
          does on this PC right now.
        </p>
        {caps?.topology && (
          <p className="muted" aria-label="Detected CPU layout">
            CPU layout: {caps.topology.summary}
            {caps.topology.dualCcdX3d
              ? " Dual-CCD Ryzen X3D: Frameforge leaves your game's cores and core parking alone."
              : ""}
          </p>
        )}
        {mechanisms.pauseServices && (
          <div className="notice">
            <Info size={18} />
            <div>
              <p>
                <strong>Pausing services needs administrator approval.</strong>{" "}
                Frameforge stops (never disables) a short list of background
                Windows services for the session and starts them again at the
                end. Windows shows one approval prompt when the boost starts and
                one when it ends. If you decline the first, the rest of the
                boost still runs and no service is touched. Auto-boost never
                shows the prompt, so services are only paused when you start a
                boost yourself. Windows, audio, network, input, security,
                Windows Update, anti-cheat and GPU services are never touched.
                If Frameforge is closed unexpectedly, paused services return
                when Windows restarts, or sooner with Retry recovery.
              </p>
            </div>
          </div>
        )}
        <div className="mode-grid">
          {modes
            .filter((m) => m.id !== "off")
            .map((m) => {
              const list = enabled(
                m.id === "custom" ? config.custom : modeMechanisms[m.id],
              );
              const plans = list.map((entry) => ({
                entry,
                plan: onThisPc(entry, cap(entry.id), config.background, {
                  preset: m.id !== "custom",
                  threadDirector: !!caps?.topology?.threadDirector,
                }),
              }));
              const effects = plans.filter((p) => p.plan.tone === "lime");
              const applies = effects.length;
              // Until this PC has been checked everything is "checking"; afterwards only real effects are listed as effects.
              const shown = caps ? effects : plans;
              const notApplied = caps
                ? plans.filter((p) => p.plan.tone !== "lime")
                : [];
              return (
                <article
                  key={m.id}
                  className={`mode-card ${config.mode === m.id ? "selected" : ""}`}
                  aria-label={`${m.label} on this PC`}
                >
                  <h3>
                    {m.label}
                    {config.mode === m.id && (
                      <Badge tone="cyan">selected</Badge>
                    )}
                  </h3>
                  <p className="muted">
                    {caps
                      ? `Changes ${applies} of ${list.length} on this PC.`
                      : "Checking this PC…"}
                  </p>
                  <ul className="mechanism-list">
                    {shown.map(({ entry, plan }) => (
                      <li key={entry.id}>
                        <span>{labels[entry.id]}</span>
                        <Badge tone={plan.tone}>{plan.label}</Badge>
                        {plan.reason && (
                          <small className="muted">{plan.reason}</small>
                        )}
                      </li>
                    ))}
                    {!list.length && (
                      <li className="muted">Nothing selected yet.</li>
                    )}
                  </ul>
                  {notApplied.length > 0 && (
                    <>
                      <p className="muted">Not applied on this PC:</p>
                      <ul
                        className="mechanism-list"
                        aria-label={`${m.label}: not applied on this PC`}
                      >
                        {notApplied.map(({ entry, plan }) => (
                          <li key={entry.id}>
                            <span>{labels[entry.id]}</span>
                            <Badge tone={plan.tone}>{plan.label}</Badge>
                            {plan.reason && (
                              <small className="muted">{plan.reason}</small>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </article>
              );
            })}
        </div>
        <ul className="mechanism-list">
          <li>
            <span>{labels.powerPlan} on this PC</span>
            <Badge tone={cap("powerPlan")?.available ? "lime" : "amber"}>
              {cap("powerPlan")?.available ? "available" : "unavailable"}
            </Badge>
            <small className="muted">
              {cap("powerPlan")?.detail ?? "Checking…"}
              {status?.ownedPowerPlan
                ? " Frameforge created this plan with your consent."
                : ""}
            </small>
            {!unavailable &&
              caps &&
              !cap("powerPlan")?.available &&
              !status?.ownedPowerPlan && (
                <Button
                  disabled={pending || !!session}
                  title={
                    session
                      ? "Stop the boost session first."
                      : "Create a copy of Windows' High performance plan for boost sessions."
                  }
                  onClick={() => setConfirmPlan(true)}
                >
                  <Plus size={17} /> Create High performance plan…
                </Button>
              )}
            {!unavailable && status?.ownedPowerPlan && (
              <Button
                disabled={pending || !!session}
                title={
                  session
                    ? "Stop the boost session first."
                    : "Remove the plan Frameforge created. Your other plans are untouched."
                }
                onClick={async () => {
                  const result = await run("boostPowerPlan", {
                    action: "remove",
                    confirmed: true,
                  });
                  if (result) setStatus(result);
                }}
              >
                <Trash2 size={17} /> Remove Frameforge plan
              </Button>
            )}
          </li>
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
      {confirmPlan && (
        <Modal
          title="Create a High performance power plan?"
          description="Windows has no High performance plan on this PC, so the power-plan step of a boost does nothing."
          onClose={() => setConfirmPlan(false)}
        >
          <p className="muted">
            Frameforge copies Windows' built-in High performance plan into a new
            plan named “Frameforge High performance”. Your current plan stays
            active. During a boost Frameforge switches to the new plan and
            switches back afterwards. High performance uses more power and can
            run your PC warmer. You can remove the plan here at any time; your
            other plans are never changed.
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setConfirmPlan(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={async () => {
                const result = await run("boostPowerPlan", {
                  action: "create",
                  confirmed: true,
                });
                setConfirmPlan(false);
                if (result) setStatus(result);
              }}
            >
              Create plan
            </Button>
          </div>
        </Modal>
      )}
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
                ? `Unavailable: ${cap("powerPlan")!.detail}. Create a plan under Mode to use it.`
                : "Switches to High performance (or Ultimate, if present) and back."
            }
            checked={config.custom.powerPlan}
            disabled={
              pending ||
              (cap("powerPlan")?.available === false &&
                !config.custom.powerPlan)
            }
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
            label="Game Bar capture off"
            description={
              cap("gameBarCapture")?.detail ??
              "Turns off background recording and capture for the session. Game Mode stays on and the Game Bar app stays installed, which AMD X3D game detection needs."
            }
            checked={config.custom.gameBarCapture}
            disabled={pending}
            onChange={(v) => void setCustom({ gameBarCapture: v })}
          />
          <Toggle
            label="Power throttling opt-out"
            description={
              cap("powerThrottling")?.available === false
                ? `Unsupported: ${cap("powerThrottling")!.detail}`
                : "Asks Windows not to treat the game as efficiency (EcoQoS) work. Applies to the game process only."
            }
            checked={config.custom.powerThrottling}
            disabled={
              pending ||
              (cap("powerThrottling")?.available === false &&
                !config.custom.powerThrottling)
            }
            onChange={(v) => void setCustom({ powerThrottling: v })}
          />
          <Toggle
            label="Smart core targeting"
            description={
              cap("smartCores")?.available === false
                ? `Unsupported: ${cap("smartCores")!.detail}`
                : `Steers the game to the performance cores of a hybrid CPU with CPU sets. Off in the presets on Windows 11, where the CPU scheduler already does this; here you can force it. ${cap("smartCores")?.detail ?? "Checking this PC…"}`
            }
            checked={config.custom.smartCores}
            disabled={
              pending ||
              (cap("smartCores")?.available === false &&
                !config.custom.smartCores)
            }
            onChange={(v) => void setCustom({ smartCores: v })}
          />
          <Toggle
            label="Disable core parking"
            description={
              cap("coreParking")?.available === false
                ? `Unsupported: ${cap("coreParking")!.detail}`
                : `Raises the plugged-in minimum of unparked cores to 100% for the session and restores your value. On hybrid CPUs this also raises the performance-core setting (CPMINCORES1) and restores it too. Battery settings are not changed. ${cap("coreParking")?.detail ?? "Checking this PC…"}`
            }
            checked={config.custom.coreParking}
            disabled={
              pending ||
              (cap("coreParking")?.available === false &&
                !config.custom.coreParking)
            }
            onChange={(v) => void setCustom({ coreParking: v })}
          />
          <Toggle
            label="Pause Windows services (asks for administrator approval)"
            description={
              cap("pauseServices")?.available === false
                ? `Unavailable: ${cap("pauseServices")!.detail}`
                : `Stops a short list of safe background services for the session, then restarts them. Windows shows an approval prompt when the boost starts and when it ends; declining the first one skips only this step. Start types are never changed. Printing is unavailable while Print Spooler is paused. ${cap("pauseServices")?.detail ?? "Checking this PC…"}`
            }
            checked={config.custom.pauseServices}
            disabled={
              pending ||
              (cap("pauseServices")?.available === false &&
                !config.custom.pauseServices)
            }
            onChange={(v) => void setCustom({ pauseServices: v })}
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
              {mechanisms[
                entry.action === "lower"
                  ? "lowerBackground"
                  : entry.action === "suspend"
                    ? "suspendBackground"
                    : "closeBackground"
              ] ? (
                <Badge tone="lime">applies in {modeName(config.mode)}</Badge>
              ) : (
                <Badge tone="amber">not part of {modeName(config.mode)}</Badge>
              )}
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
              {suggested.length > 0 && (
                <div className="booster-chips" aria-label="Suggested apps">
                  {suggested.map(({ image, action, kind }) => (
                    <Button
                      key={image}
                      disabled={pending || config.background.length >= 50}
                      title={
                        config.background.length >= 50
                          ? "The list is full (50 apps). Remove one first."
                          : `Suggested ${kind}: ${action === "lower" ? "lower its priority" : "suspend it"} during a boost.`
                      }
                      onClick={() =>
                        void save({
                          background: [...config.background, { image, action }],
                        })
                      }
                    >
                      <Plus size={15} /> {image} ({kind})
                    </Button>
                  ))}
                </div>
              )}
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
                title={
                  config.background.length >= 50
                    ? "The list is full (50 apps). Remove one first."
                    : !pick
                      ? "Choose an app first."
                      : undefined
                }
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
              onClick={() =>
                willPauseServices ? setConfirmServices(true) : void startBoost()
              }
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
      {confirmServices && (
        <Modal
          title="Pause Windows services for this boost?"
          description="This mode pauses a short list of background services, which needs administrator approval."
          onClose={() => setConfirmServices(false)}
        >
          <p className="muted">
            Windows will show an administrator prompt now, and another one when
            the boost ends so the services can be restarted. Declining the first
            prompt only skips this step; everything else in the mode still runs.
            Frameforge stops these services and never disables them:{" "}
            {cap("pauseServices")?.detail}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setConfirmServices(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                setConfirmServices(false);
                void startBoost();
              }}
            >
              Continue
            </Button>
          </div>
        </Modal>
      )}
      <section className="booster-section" aria-label="Launch settings">
        <h2>Launch settings for {game?.name ?? "a game"}</h2>
        <p className="muted">
          Windows reads these two per-game settings when the game starts, so
          they are not part of a boost session. You apply each one yourself,
          Frameforge saves the exact value from before, and it stays until you
          press Revert. Every change is listed in Activity.
        </p>
        {launchError && (
          <p className="notice" role="alert" data-error="true">
            {launchError}
          </p>
        )}
        {!game && <p className="muted">Add a game first.</p>}
        {data.mode === "demo" && (
          <p className="muted">Launch settings require the desktop app.</p>
        )}
        {launch && launch.gameId === gameId && (
          <ul className="mechanism-list">
            {launch.settings.map((s) => (
              <li key={s.setting}>
                <span>{launchLabels[s.setting]}</span>
                <Badge
                  tone={
                    s.state === "applied"
                      ? "lime"
                      : s.state === "ready" || s.state === "already-set"
                        ? "neutral"
                        : "amber"
                  }
                >
                  {s.state === "applied"
                    ? "set by Frameforge"
                    : s.state === "ready"
                      ? "not set"
                      : s.state === "already-set"
                        ? "already set"
                        : s.state}
                </Badge>
                <small className="muted">{s.detail}</small>
                {s.current !== null && (
                  <small className="muted">Current value: {s.current}</small>
                )}
                {s.state === "ready" && (
                  <Button
                    disabled={pending}
                    title="Review the change before it is made."
                    onClick={async () => {
                      try {
                        const preview = await request("launchSettingPreview", {
                          gameId,
                          setting: s.setting,
                          action: "apply",
                        });
                        setLaunchDialog({
                          setting: s.setting,
                          action: "apply",
                          preview,
                        });
                      } catch (error) {
                        setLaunchError(
                          error instanceof Error
                            ? error.message
                            : "The preview failed.",
                        );
                      }
                    }}
                  >
                    Review and apply…
                  </Button>
                )}
                {s.canRevert && (
                  <Button
                    disabled={pending}
                    title="Restore the value from before Frameforge changed it."
                    onClick={async () => {
                      try {
                        const preview = await request("launchSettingPreview", {
                          gameId,
                          setting: s.setting,
                          action: "revert",
                        });
                        setLaunchDialog({
                          setting: s.setting,
                          action: "revert",
                          preview,
                        });
                      } catch (error) {
                        setLaunchError(
                          error instanceof Error
                            ? error.message
                            : "The preview failed.",
                        );
                      }
                    }}
                  >
                    <RotateCcw size={17} /> Revert
                  </Button>
                )}
                {s.state === "conflict" && (
                  <Button
                    disabled={pending}
                    title="Drop Frameforge's saved value without changing Windows."
                    onClick={() =>
                      setLaunchDialog({
                        setting: s.setting,
                        action: "forget",
                        preview: null,
                      })
                    }
                  >
                    Forget saved value
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {launchDialog && (
        <Modal
          title={
            launchDialog.action === "apply"
              ? `Apply: ${launchLabels[launchDialog.setting]}?`
              : launchDialog.action === "revert"
                ? `Revert: ${launchLabels[launchDialog.setting]}?`
                : "Forget the saved value?"
          }
          description={
            launchDialog.preview?.exe ??
            "Frameforge will stop tracking this change."
          }
          onClose={() => setLaunchDialog(null)}
        >
          {launchDialog.preview ? (
            <>
              <p className="muted">{launchDialog.preview.warning}</p>
              <ul className="mechanism-list">
                <li>
                  <span>Now</span>
                  <code>{launchDialog.preview.before ?? "(not set)"}</code>
                </li>
                <li>
                  <span>After</span>
                  <code>{launchDialog.preview.after ?? "(not set)"}</code>
                </li>
              </ul>
            </>
          ) : (
            <p className="muted">
              Windows is not changed. Frameforge drops the saved prior value, so
              it can no longer restore it. Use this when the value was changed
              outside Frameforge and you want to keep that change.
            </p>
          )}
          <div className="dialog-actions">
            <Button onClick={() => setLaunchDialog(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={async () => {
                const dialog = launchDialog;
                setLaunchDialog(null);
                const status = await run("launchSettingApply", {
                  gameId,
                  setting: dialog.setting,
                  action: dialog.action,
                  confirmed: true,
                });
                if (status) setLaunch(status);
              }}
            >
              {launchDialog.action === "apply"
                ? "Apply"
                : launchDialog.action === "revert"
                  ? "Revert"
                  : "Forget"}
            </Button>
          </div>
        </Modal>
      )}
      <section className="booster-section" aria-label="Network check">
        <h2>
          <Wifi size={18} /> Network check
        </h2>
        <p className="muted">
          Diagnostics only: sends 10 ICMP pings to one host and reports latency,
          jitter and packet loss. Nothing on your PC is changed. It measures the
          path to that host, not your game traffic, and some hosts ignore pings.
          Enter the address of your game server or region if you know it; the
          buttons are public reference targets, not game servers.
        </p>
        <div className="toolbar">
          <label className="field">
            Host name or IP address
            <input
              type="text"
              value={netHost}
              maxLength={253}
              placeholder="example.com or 203.0.113.5"
              disabled={netBusy}
              onChange={(e) => setNetHost(e.target.value)}
            />
          </label>
          <Button
            variant="primary"
            disabled={
              netBusy || !hostValid || !!unavailable || data.mode === "demo"
            }
            title={
              unavailable ||
              (!hostValid
                ? "Enter a valid host name or IP address."
                : undefined)
            }
            onClick={() => void checkNetwork(hostTrimmed)}
          >
            {netBusy ? "Checking…" : "Check network"}
          </Button>
        </div>
        <div className="booster-chips" aria-label="Reference targets">
          {referenceTargets.map((t) => (
            <Button
              key={t.host}
              disabled={netBusy || !!unavailable}
              title={unavailable || `Ping ${t.host} (${t.label}).`}
              onClick={() => {
                setNetHost(t.host);
                void checkNetwork(t.host);
              }}
            >
              {t.label} ({t.host})
            </Button>
          ))}
        </div>
        {netError && (
          <p className="notice" role="alert" data-error="true">
            {netError}
          </p>
        )}
        {netResult && (
          <div role="status" aria-label="Network check result">
            <ul className="mechanism-list">
              <li>
                <span>Host</span>
                <strong>
                  {netResult.host}
                  {netResult.address ? ` (${netResult.address})` : ""}
                </strong>
              </li>
              <li>
                <span>Replies</span>
                <strong>
                  {netResult.received} of {netResult.sent}
                </strong>
              </li>
              <li>
                <span>Packet loss</span>
                <strong>{netResult.lossPercent}%</strong>
              </li>
              <li>
                <span>Latency (min / avg / max)</span>
                <strong>
                  {netResult.avgMs === null
                    ? "no replies"
                    : `${netResult.minMs} / ${netResult.avgMs} / ${netResult.maxMs} ms`}
                </strong>
              </li>
              <li>
                <span>Jitter</span>
                <strong>
                  {netResult.jitterMs === null
                    ? "n/a"
                    : `${netResult.jitterMs} ms`}
                </strong>
              </li>
            </ul>
            <p className="muted">{netResult.message}</p>
          </div>
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
