import { Gamepad2 } from "lucide-react";
import { Badge, Button, Panel, Toggle } from "../../components/ui";
import { request } from "../../api";
import { kindLabel } from "../../../shared/smart";
import type {
  AppState,
  Game,
  SmartProfile,
  SmartStatus,
  SmartVerdict,
} from "../../../shared/contracts";
import type { ViewProps } from "../../types";

const kindTone = {
  "cpu-bound": "amber",
  "gpu-bound": "cyan",
  memory: "amber",
  thermal: "red",
  "frame-capped": "neutral",
  unknown: "neutral",
} as const;

/** The reasoning behind a Smart session or a saved profile: what limits the game, why, what changed and the next step. */
export function Verdict({
  verdict,
  title = "What Smart mode found",
}: {
  verdict: Pick<
    SmartVerdict,
    "classification" | "reasons" | "advice" | "nextAction"
  > &
    Partial<Pick<SmartVerdict, "chosen" | "profileUsed">>;
  title?: string;
}) {
  return (
    <div className="smart-verdict" aria-label="Smart mode verdict">
      <span className="label">{title}</span>
      <h3>
        <Badge tone={kindTone[verdict.classification]}>
          {kindLabel[verdict.classification]}
        </Badge>
      </h3>
      <ul aria-label="Why">
        {verdict.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {verdict.chosen && verdict.chosen.length > 0 && (
        <p className="muted">
          Applied only: {verdict.chosen.join(", ")}. Windows Game Mode is never
          changed.
        </p>
      )}
      {verdict.advice.length > 0 && (
        <ul aria-label="Advice">
          {verdict.advice.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      <p>
        <strong>Next best step:</strong> {verdict.nextAction}
      </p>
    </div>
  );
}

/** Smart mode on the Game Mode page: how it works, what it is doing now, what it learned for the picked game. */
export function SmartPanel({
  game,
  settings,
  smart,
  setSmart,
  run,
  pending,
  unavailable,
}: {
  game: Game | undefined;
  settings: AppState["settings"];
  smart: SmartStatus;
  setSmart: (s: SmartStatus) => void;
  run: ViewProps["run"];
  pending: boolean;
  unavailable: string;
}) {
  const profile: SmartProfile | undefined = smart.profiles.find(
    (p) => p.gameId === game?.id,
  );
  const watching = smart.observing;
  return (
    <Panel className="smart-panel" aria-label="Smart mode">
      <div>
        <h2>Smart mode</h2>
        <p className="muted">
          For the first minute Frameforge only watches the game (CPU, GPU,
          memory, clocks). Then it applies only what helps and restores
          everything when the game exits. It remembers the result for next time,
          never claims an FPS gain and never changes Windows Game Mode.
        </p>
      </div>
      {watching && (
        <div role="status" aria-label="Smart mode is watching">
          <p>
            Watching <strong>{watching.gameName}</strong> —{" "}
            {watching.elapsedSeconds} of {watching.totalSeconds} seconds.
            Nothing has been changed yet.
          </p>
          <div className="smart-progress">
            <span
              style={{
                width: `${Math.min(100, (watching.elapsedSeconds / Math.max(1, watching.totalSeconds)) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}
      {profile && game ? (
        <>
          <Verdict
            verdict={{
              classification: profile.classification,
              reasons: profile.reasons,
              advice: profile.advice,
              nextAction: profile.nextAction,
            }}
            title={`Learned for ${profile.gameName} (${profile.at.slice(0, 10)}, ${profile.sessions} session${profile.sessions === 1 ? "" : "s"})`}
          />
          <div className="toolbar">
            <Button
              disabled={pending || !!watching}
              title="Delete what was learned; the next launch watches the game again."
              onClick={async () => {
                const next = await request("smartForget", {
                  gameId: profile.gameId,
                });
                setSmart(next);
              }}
            >
              Forget and learn again
            </Button>
          </div>
        </>
      ) : (
        !watching && (
          <p className="muted">
            {game
              ? `Nothing learned for ${game.name} yet. The next time it starts in Smart mode it is watched for a minute first.`
              : "Add a game to the library to begin."}
          </p>
        )
      )}
      <Toggle
        label="Let Smart mode ask for administrator approval"
        description="Pausing Windows Update, Click-to-Run and similar services for the session (and clearing the standby list when memory is really tight) needs one Windows administrator prompt when a game starts. Off: those steps are skipped and shown as skipped, and nothing opens while you play. On: Windows asks once at the start and once at the end. Declining is always fine."
        checked={settings.autoBoostAdmin}
        disabled={pending || !!unavailable}
        onChange={(autoBoostAdmin) =>
          void run(
            "settings",
            { ...settings, autoBoostAdmin },
            autoBoostAdmin
              ? "Smart mode and auto-boost may now ask for administrator approval."
              : "Admin steps are skipped in the background.",
          )
        }
      />
    </Panel>
  );
}

/** "Add to library?" for a fullscreen program Frameforge noticed. It is only an offer: nothing is added or boosted until yes. */
export function SmartOffer({
  smart,
  setSmart,
  run,
  pending,
}: {
  smart: SmartStatus;
  setSmart: (s: SmartStatus) => void;
  run: ViewProps["run"];
  pending: boolean;
}) {
  const c = smart.candidate;
  if (!c) return null;
  return (
    <div className="notice smart-offer" role="status" aria-label="Game found">
      <Gamepad2 size={18} />
      <div>
        <p>
          <strong>{c.name}</strong> ran fullscreen and kept your GPU busy for
          over 30 seconds. Add it to the library so Smart mode can look after
          it?
        </p>
        <p className="muted">{c.path}</p>
      </div>
      <Button
        variant="primary"
        disabled={pending}
        onClick={async () => {
          const next = await run("smartCandidate", { action: "add" });
          if (next) setSmart(next);
        }}
      >
        Add to library
      </Button>
      <Button
        disabled={pending}
        onClick={async () => {
          const next = await request("smartCandidate", { action: "dismiss" });
          setSmart(next);
        }}
      >
        Not a game
      </Button>
    </div>
  );
}
