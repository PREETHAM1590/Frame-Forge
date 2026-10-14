import { RotateCcw, Square } from "lucide-react";
import { Badge, Button, Panel, StatCell } from "../../components/ui";
import { GameIcon } from "../../components/GameIcon";
import type { BoostSession, Game } from "../../../shared/contracts";
import type { ViewProps } from "../../types";
import { labels, modes, stateText, tones } from "./model";
import { SessionChanges } from "./SessionChanges";

type Outcome = { text: string; error: boolean };

/** A session needing recovery: the only two honest choices are retry or keep Windows as it is. */
export function RecoveryNotice({
  session,
  run,
  pending,
  available,
  unavailable,
  setOutcome,
}: {
  session: BoostSession;
  run: ViewProps["run"];
  pending: boolean;
  available: boolean;
  unavailable: string;
  setOutcome: (o: Outcome) => void;
}) {
  return (
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
  );
}

/** The live session: what is applied, a CPU/RAM snapshot (not FPS), the live log and Stop. */
export function SessionPanel({
  session,
  game,
  minutes,
  log,
  run,
  pending,
  setOutcome,
}: {
  session: BoostSession;
  game: Game | undefined;
  minutes: number | null;
  log: string[];
  run: ViewProps["run"];
  pending: boolean;
  setOutcome: (o: Outcome) => void;
}) {
  const sample = session.samples.at(-1);
  const waiting =
    session.status === "preparing" || session.status === "restoring";
  return (
    <div className="gm-session">
      <Panel tone="accent" aria-label="Boost session">
        <div className="gm-session-head">
          {game && <GameIcon game={game} size={64} />}
          <div>
            <span className="label">Live session</span>
            <h2>{game?.name ?? "Boosted game"}</h2>
            <p className="muted" role="status">
              {session.message}
            </p>
          </div>
        </div>
        <div className="cells gm-session-stats">
          <StatCell
            label="Mode"
            value={modes.find((m) => m.id === session.mode)?.label}
          />
          <StatCell
            label="Uptime"
            value={minutes === null ? "-" : `${minutes} min`}
          />
          <StatCell
            label="System snapshot (not FPS)"
            value={
              <span className="stat-text">
                {sample
                  ? `CPU ${sample.systemCpuPercent.toFixed(0)}%, free RAM ${(sample.availableMemoryBytes / 1024 ** 3).toFixed(1)} GB, game ${(sample.gameWorkingSetBytes / 1024 ** 2).toFixed(0)} MB`
                  : "First sample after 30 s"}
              </span>
            }
          />
        </div>
        <ul className="booster-chips" aria-label="Mechanism results">
          {session.mechanisms.map((m, i) => (
            <li key={i} title={m.detail}>
              <Badge tone={tones[m.state]}>
                {labels[m.id]}: {stateText(m)}
              </Badge>
            </li>
          ))}
        </ul>
        <SessionChanges session={session} />
        <Button
          variant="primary"
          disabled={pending || waiting}
          title={
            waiting
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
      </Panel>
      <SessionLog log={log} />
    </div>
  );
}

export function SessionLog({ log }: { log: string[] }) {
  if (!log.length) return null;
  return (
    <section className="gm-log" aria-label="Session log">
      <h2 className="label">Session log</h2>
      <ol className="booster-log" aria-live="polite">
        {log.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>
    </section>
  );
}
