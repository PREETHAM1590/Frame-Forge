import { useCallback, useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import {
  PageTitle,
  Button,
  Badge,
  Disclosure,
  Modal,
  Panel,
  SectionHeader,
  Toggle,
} from "../components/ui";
import { desktopOnly, onEvent, request } from "../api";
import { PowerPlanDialog } from "../components/PowerPlanDialog";
import {
  effectiveMechanisms,
  type BoostMode,
  type BoostSession,
  type BoosterConfig,
  type MechanismId,
} from "../../shared/contracts";
import type { ViewProps } from "../types";
import { labels, stateText, statusTones } from "./gamemode/model";
import type { Status } from "./gamemode/model";
import { ModeSelector } from "./gamemode/ModeSelector";
import { ModeCards } from "./gamemode/ModeCards";
import { Enhancers } from "./gamemode/Enhancers";
import { BackgroundApps } from "./gamemode/BackgroundApps";
import { LaunchSettings } from "./gamemode/LaunchSettings";
import { NetworkCheck } from "./gamemode/NetworkCheck";
import {
  RecoveryNotice,
  SessionLog,
  SessionPanel,
} from "./gamemode/SessionPanel";
import { SessionHistory } from "./gamemode/SessionChanges";
import { StartBoost } from "./gamemode/StartBoost";
import { SmartOffer, SmartPanel } from "./gamemode/SmartPanel";
import { useSmart } from "../useSmart";
import { HowItWorks } from "./gamemode/HowItWorks";

let lastPicked = "";

export function GameMode({
  data,
  run,
  pending,
  timerPending,
  navigate,
}: ViewProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const smart = useSmart();
  const [log, setLog] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  // The picked game follows the library: a scan or removal can add, remove or reorder games after this page mounted.
  // Kept across page visits and session ends; the first game is only the fallback when the picked one is gone.
  const [picked, pick] = useState(lastPicked);
  const setGameId = (id: string) => {
    lastPicked = id;
    pick(id);
  };
  const sessionGameId = data.boost.session?.gameId ?? "";
  const gameId = data.state.games.some((g) => g.id === picked)
    ? picked
    : data.state.games.some((g) => g.id === sessionGameId)
      ? sessionGameId
      : (data.state.games[0]?.id ?? "");
  const [now, setNow] = useState(0);
  const [confirmPlan, setConfirmPlan] = useState(false);
  const [confirmServices, setConfirmServices] = useState(false);
  // Per start, never remembered: the choice to boost without any administrator prompt.
  const [skipAdmin, setSkipAdmin] = useState(false);
  const [timerDialog, setTimerDialog] = useState<"enable" | "restore" | null>(
    null,
  );
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
  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "boost") return;
        const s = event.session;
        setStatus((old) =>
          old ? { ...old, session: s.status === "ended" ? null : s } : old,
        );
        const before = logged.current.id;
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
          .map((m) => `${time}  ${labels[m.id]}: ${stateText(m)}. ${m.detail}`);
        if (s.status !== seen.status) lines.push(`${time}  ${s.message}`);
        logged.current = {
          id: s.id,
          last: keys.at(-1) ?? seen.last,
          status: s.status,
        };
        // A new session starts a fresh log instead of stacking under the last one.
        const fresh = before !== s.id;
        if (lines.length)
          setLog((old) => (fresh ? lines : [...old, ...lines].slice(-80)));
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
  const mechanisms = effectiveMechanisms(config);
  const saveGame = (background: BoosterConfig["background"] | null) =>
    game
      ? run(
          "profile",
          {
            id: game.id,
            boostMode: game.boostMode,
            notes: game.notes,
            background,
          },
          background
            ? `Apps list saved for ${game.name}.`
            : `${game.name} uses the all-games list again.`,
        )
      : Promise.resolve(undefined);
  const game = data.state.games.find((g) => g.id === gameId);
  const gameMode = game
    ? game.boostMode === "global"
      ? config.mode
      : game.boostMode
    : config.mode;
  const sessionGame = data.state.games.find((g) => g.id === session?.gameId);
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
    gameMode === "off" ? null : effectiveMechanisms(config, gameMode);
  const pausesServices =
    !!gameMechanisms?.pauseServices && cap("pauseServices")?.available === true;
  const clearsStandby =
    !!gameMechanisms?.standbyPurge && cap("standbyPurge")?.available === true;
  // Either step opens the administrator prompt, so either one gets the explanation first.
  const willPauseServices = pausesServices || clearsStandby;
  const timer = status?.timer;
  const startBoost = async (skip = false) => {
    const result = await run("boostStart", {
      gameId,
      confirmed: true,
      ...(skip && { skipAdmin: true }),
    });
    if (result)
      setOutcome({
        text: result.message,
        error: result.status !== "active",
      });
  };
  const minutes =
    session && now
      ? Math.max(0, Math.floor((now - Date.parse(session.startedAt)) / 60000))
      : null;

  const sessionActive = session && session.status !== "recovery-needed";
  const startHere = () =>
    willPauseServices
      ? (setSkipAdmin(false), setConfirmServices(true))
      : void startBoost();
  return (
    <div className="gm">
      <PageTitle
        eyebrow="Kernel profile"
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
        <RecoveryNotice
          session={session}
          run={run}
          pending={pending}
          available={available}
          unavailable={unavailable}
          setOutcome={setOutcome}
        />
      )}
      <SmartOffer
        smart={smart.status}
        setSmart={smart.set}
        run={run}
        pending={pending}
      />
      <div className="gm-grid">
        <aside className="gm-side">
          <HowItWorks />
          <Panel flush>
            <SectionHeader
              level={3}
              title="Game enhancers"
              aside={<span className="label">Advanced</span>}
            />
            <div className="gm-side-body">
              <Enhancers
                config={config}
                status={status}
                caps={caps}
                cap={cap}
                timer={timer}
                unavailable={unavailable}
                pending={pending}
                timerPending={timerPending}
                session={!!session}
                run={run}
                save={save}
                setStatus={setStatus}
                onCreatePlan={() => setConfirmPlan(true)}
                onTimerDialog={setTimerDialog}
              />
            </div>
          </Panel>
        </aside>
        <div className="gm-main">
          {sessionActive && (
            <SessionPanel
              session={session}
              game={sessionGame}
              minutes={minutes}
              log={log}
              run={run}
              pending={pending}
              setOutcome={setOutcome}
            />
          )}
          {gameMode === "smart" && (
            <SmartPanel
              game={game}
              settings={data.state.settings}
              smart={smart.status}
              setSmart={smart.set}
              run={run}
              pending={pending}
              unavailable={unavailable}
            />
          )}
          <StartBoost
            games={data.state.games}
            game={game}
            gameId={gameId}
            gameMode={gameMode}
            session={!!session}
            startReason={startReason}
            onPick={setGameId}
            onStart={startHere}
            onOpenLibrary={() => navigate("Game library")}
          />
          {!sessionActive && <SessionLog log={log} />}
          {!sessionActive && (
            <SessionHistory
              key={session?.status ?? "none"}
              limit={1}
              names={Object.fromEntries(
                data.state.games.map((g) => [g.id, g.name]),
              )}
            />
          )}
          <ModeSelector
            mode={config.mode}
            pending={pending}
            caps={caps}
            mechanisms={mechanisms}
            onSelect={(mode: BoostMode) => void save({ mode })}
          />
          <ModeCards
            config={config}
            caps={caps}
            cap={cap}
            timer={timer}
            pending={pending}
            onSelect={(mode) => void save({ mode })}
          />
          <Disclosure
            title="Close or pause apps while gaming"
            hint={config.backgroundChosen ? "Your list" : "Suggested"}
          >
            <Toggle
              label="Clean up when a boost starts"
              description="When a boost starts, close the apps picked below, then trim the memory big background programs hold. Pausing and closing happen first; memory is only freed when it was tight, and the result is shown after the boost starts."
              checked={data.state.settings.boostCleanup !== false}
              disabled={pending || !!unavailable}
              onChange={(boostCleanup) =>
                run(
                  "settings",
                  { ...data.state.settings, boostCleanup },
                  boostCleanup
                    ? "Boosts now close the picked apps and free memory first."
                    : "Boosts no longer close apps or free memory first.",
                )
              }
            />
            <BackgroundApps
              config={config}
              game={game}
              save={save}
              saveGame={saveGame}
              pending={pending}
              unavailable={unavailable}
              desktop={data.mode === "desktop"}
            />
          </Disclosure>
          <Disclosure title="Launch settings" hint="Advanced">
            <LaunchSettings
              data={data}
              game={game}
              gameId={gameId}
              run={run}
              pending={pending}
            />
          </Disclosure>
          <Disclosure title="Network check" hint="Diagnostics">
            <NetworkCheck
              unavailable={unavailable}
              demo={data.mode === "demo"}
            />
          </Disclosure>
        </div>
      </div>
      {confirmPlan && (
        <PowerPlanDialog
          run={run}
          pending={pending}
          onClose={() => setConfirmPlan(false)}
          onDone={() => void refresh()}
        />
      )}
      {timerDialog && (
        <Modal
          title={
            timerDialog === "enable"
              ? "Allow games to keep high timer resolution?"
              : "Turn the Windows timer setting back off?"
          }
          description={
            timerDialog === "enable"
              ? "Windows 11 only lets a program's fine timer request reach other programs when a system setting is on."
              : "Frameforge will put back the value it saved before it turned the setting on."
          }
          onClose={() => setTimerDialog(null)}
        >
          <p className="muted">
            {timerDialog === "enable"
              ? "Frameforge sets GlobalTimerResolutionRequests to 1 under HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel. That needs one Windows administrator approval, and Windows reads it only at start-up, so you must restart Windows (choose Restart; a Shut down with Fast Startup keeps the old session) before the High timer resolution step can work. Frameforge saves the current value first and “Turn back off” restores exactly that. A finer timer raises power use while a game runs. Nothing else is changed."
              : "This needs one Windows administrator approval and, like turning it on, takes effect after a restart of Windows. If the value was changed by something else since, that change is kept."}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setTimerDialog(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={async () => {
                const action = timerDialog;
                setTimerDialog(null);
                const result = await run("boostTimerGlobal", {
                  action,
                  confirmed: true,
                });
                if (result) setStatus(result);
              }}
            >
              {timerDialog === "enable" ? "Allow it" : "Turn back off"}
            </Button>
          </div>
        </Modal>
      )}
      {confirmServices && (
        <Modal
          title={
            pausesServices && clearsStandby
              ? "Pause services and clear the standby memory list for this boost?"
              : pausesServices
                ? "Pause Windows services for this boost?"
                : "Clear the standby memory list for this boost?"
          }
          description={
            pausesServices && clearsStandby
              ? "This mode pauses a short list of background services and clears Windows' cached memory once. Both need administrator approval, in one prompt."
              : pausesServices
                ? "This mode pauses a short list of background services, which needs administrator approval."
                : "This mode clears Windows' cached (standby) memory once at the start, which needs administrator approval."
          }
          onClose={() => setConfirmServices(false)}
        >
          <p className="muted">
            The boost starts right away. Windows then shows an administrator
            prompt
            {pausesServices
              ? ", and another one when the boost ends so paused services can be restarted"
              : ""}
            . Declining the prompt, leaving it unanswered for 2 minutes, or
            pressing Stop only skips{" "}
            {pausesServices && clearsStandby ? "these steps" : "this step"};
            everything else in the mode still runs.{" "}
            {pausesServices &&
              `Frameforge stops services and never disables them: ${cap("pauseServices")?.detail ?? ""} `}
            {clearsStandby &&
              "Clearing the standby list cannot be undone and is harmless: Windows refills the cache as programs need memory."}
          </p>
          <div className="check-list">
            <label>
              <input
                type="checkbox"
                checked={skipAdmin}
                onChange={(e) => setSkipAdmin(e.target.checked)}
              />
              <span>Skip steps that need administrator approval</span>
            </label>
          </div>
          <p className="muted">
            {skipAdmin
              ? "No administrator prompt will open. These steps are shown as skipped and the rest of the mode still runs."
              : "Tick this to boost without any administrator prompt."}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setConfirmServices(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                setConfirmServices(false);
                void startBoost(skipAdmin);
              }}
            >
              Continue
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
