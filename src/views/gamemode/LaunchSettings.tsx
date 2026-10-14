import { useEffect, useState } from "react";
import { Info, RotateCcw } from "lucide-react";
import { Badge, Button, Modal } from "../../components/ui";
import { request } from "../../api";
import type {
  Game,
  LaunchPreview,
  LaunchSetting,
  LaunchStatus,
} from "../../../shared/contracts";
import type { ViewProps } from "../../types";
import { launchLabels } from "./model";

/** Per-game Windows launch settings. Reads once per game (or on Re-check), never on app state changes. */
export function LaunchSettings({
  data,
  game,
  gameId,
  run,
  pending,
}: Pick<ViewProps, "data" | "run" | "pending"> & {
  game: Game | undefined;
  gameId: string;
}) {
  const [launch, setLaunch] = useState<LaunchStatus | null>(null);
  const [launchError, setLaunchError] = useState("");
  const [confirmPick, setConfirmPick] = useState(false);
  const [launchDialog, setLaunchDialog] = useState<{
    setting: LaunchSetting;
    action: "apply" | "revert" | "forget";
    preview: LaunchPreview | null;
  } | null>(null);
  const [launchTick, setLaunchTick] = useState(0);
  const launchGameId = gameId;
  const launchExe = data.state.games.find(
    (g) => g.id === gameId,
  )?.executablePath;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `data.mode` is stable for the session; the rest are listed.
  }, [launchGameId, launchExe, launchTick]);
  return (
    <>
      <section className="gm-sub" aria-label="Launch settings">
        <h3 className="gm-sub-title">For {game?.name ?? "a game"}</h3>
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
        {data.mode !== "demo" && game && launch && !launch.executable && (
          <div className="notice">
            <Info size={18} />
            <div>
              <p>
                Frameforge does not know which program starts {game.name}, so
                launch settings are off. Choose its .exe (inside the game's
                folder) to turn them on.
              </p>
              <Button
                disabled={pending}
                onClick={async () => {
                  // Without a game folder nothing proves the file belongs to the game, so ask first.
                  if (!game.path) {
                    setConfirmPick(true);
                    return;
                  }
                  const chosen = await run("chooseExecutable", { id: gameId });
                  if (chosen) setLaunchTick((n) => n + 1);
                }}
              >
                Choose the game's .exe…
              </Button>
            </div>
          </div>
        )}
        {data.mode !== "demo" && game && (
          <div className="toolbar">
            <Button
              disabled={pending}
              title="Read the current values again."
              onClick={() => setLaunchTick((n) => n + 1)}
            >
              Re-check
            </Button>
          </div>
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
                        : s.state === "recovery-needed"
                          ? "red"
                          : "amber"
                  }
                >
                  {s.state === "applied"
                    ? "set by Frameforge"
                    : s.state === "ready"
                      ? "not set"
                      : s.state === "already-set"
                        ? "already set"
                        : s.state === "recovery-needed"
                          ? "recovery needed"
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
                {s.canRevert && s.state !== "applied" && (
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
      {confirmPick && game && (
        <Modal
          title="Choose the game's own .exe?"
          description={`Frameforge does not know where ${game.name} is installed, so it cannot check that the file you pick belongs to it.`}
          onClose={() => setConfirmPick(false)}
        >
          <p className="muted">
            Launch settings are saved for whichever program you choose. Pick the
            game's own executable.
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setConfirmPick(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={async () => {
                setConfirmPick(false);
                const chosen = await run("chooseExecutable", {
                  id: game.id,
                  pathConfirmed: true,
                });
                if (chosen) setLaunchTick((n) => n + 1);
              }}
            >
              Choose the .exe…
            </Button>
          </div>
        </Modal>
      )}
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
              outside Frameforge, or a failed change could not be undone, and
              you want to keep what Windows has now.
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
    </>
  );
}
