// Background mode: tray menu model, close-to-tray decision and boost notifications. Pure functions and one tiny class so they test without Electron.
import { modeLabels } from "./booster.js";
import type { BoostMode, BoostSession } from "../shared/contracts.js";
import { summarizeSession } from "../shared/sessionChanges.js";

export const hiddenArg = "--hidden";
/** Started by "Launch at sign-in" (or by hand with --hidden): stay in the tray when Frameforge can keep running there. */
export const startsHidden = (argv: readonly string[], keepRunning: boolean) =>
  keepRunning && argv.includes(hiddenArg);
/** Test hooks (tray, dummy game) exist only in test mode; a packaged build also needs FRAMEFORGE_TEST_HOOKS=1. */
export const testHooksEnabled = (
  env: Record<string, string | undefined>,
  packaged: boolean,
) =>
  env.FRAMEFORGE_TEST_MODE === "1" &&
  (!packaged || env.FRAMEFORGE_TEST_HOOKS === "1");
/** A sign-in entry made before --hidden existed: re-register it so a sign-in launch goes to the tray. */
export function migrateLoginItem(login: {
  enabled(hidden: boolean): boolean;
  register(): void;
}) {
  if (login.enabled(false) && !login.enabled(true)) {
    login.register();
    return true;
  }
  return false;
}
export const trayNotice =
  "Frameforge is still running in the tray so auto-boost keeps working. To exit, right-click the tray icon and choose Quit Frameforge.";
/** Closing the window: ask the first time, then follow the saved choice. */
export const closeDecision = (
  keepRunning: boolean,
  closeAction: "ask" | "tray" | "quit",
  quitting: boolean,
): "leave" | "tray" | "ask" | "quit" =>
  quitting
    ? "leave"
    : !keepRunning || closeAction === "quit"
      ? "quit"
      : closeAction;

export interface TrayItem {
  label?: string;
  type?: "separator";
  enabled?: boolean;
  checked?: boolean;
  click?: () => void;
}
export interface TrayActions {
  open(): void;
  toggleAutoBoost(): void;
  stopBoost(): void;
  checkUpdates?(): void;
  toggleOverlay?(): void;
  quit(): void;
}
const live = (s: BoostSession | null) =>
  s !== null && ["preparing", "active", "restoring"].includes(s.status);
export function trayModel(
  input: {
    autoBoost: boolean;
    mode: BoostMode;
    session: BoostSession | null;
    gameName?: string;
    /** Is the in-game overlay on screen right now? */
    overlay?: boolean;
  },
  actions: TrayActions,
): { tooltip: string; items: TrayItem[] } {
  const running = live(input.session) ? input.session : null;
  const game = input.gameName ?? "a game";
  const status = running
    ? `${modeLabels[running.mode]} boost ${running.status === "active" ? "active" : "working"} for ${game}`
    : `Idle, mode ${modeLabels[input.mode]}`;
  return {
    tooltip: `Frameforge: ${running ? status : `auto-boost ${input.autoBoost ? "on" : "off"}, ${status.toLowerCase()}`}`,
    items: [
      { label: "Open Frameforge", click: actions.open },
      { type: "separator" },
      {
        label: "Auto-boost when a game starts",
        checked: input.autoBoost,
        click: actions.toggleAutoBoost,
      },
      { label: `Mode: ${modeLabels[input.mode]}`, enabled: false },
      { label: status, enabled: false },
      {
        label: "Stop boost",
        enabled: running?.status === "active",
        click: actions.stopBoost,
      },
      {
        label: "Toggle overlay",
        enabled: !!actions.toggleOverlay,
        checked: input.overlay === true,
        click: actions.toggleOverlay,
      },
      { type: "separator" },
      {
        label: "Check for updates",
        enabled: !!actions.checkUpdates,
        click: actions.checkUpdates,
      },
      { label: "Quit Frameforge", click: actions.quit },
    ],
  };
}

/** Windows notification text for a boost starting or ending; null when the event is not worth one. */
export class BoostNotices {
  private announced = new Set<string>();
  next(session: BoostSession, gameName: string) {
    if (session.status === "active" && !this.announced.has(session.id)) {
      this.announced.add(session.id);
      if (this.announced.size > 50) this.announced.clear();
      return {
        title: "Frameforge",
        body: `Boost started for ${gameName} (${modeLabels[session.mode]})`,
      };
    }
    if (session.status === "ended" && this.announced.delete(session.id))
      return {
        title: "Frameforge",
        body: `${
          session.failed
            ? "Boost ended. Open Frameforge to check what was restored."
            : "Boost ended, everything restored"
        }. ${summarizeSession(session).tray}`,
      };
    return null;
  }
}
