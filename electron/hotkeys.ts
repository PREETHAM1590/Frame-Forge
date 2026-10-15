// Global hotkeys: registered by the main process with Electron's globalShortcut, so they work while Frameforge sits in the tray.
// Everything here takes its dependencies as arguments, so the logic tests without Electron.
import { execFile } from "node:child_process";
import path from "node:path";
import { modeLabels } from "./booster.js";
import type { RunningGame } from "./platform.js";
import type {
  AppState,
  BoostMode,
  BoostSession,
  Game,
  ProcessTarget,
} from "../shared/contracts.js";
import { hotkeyIds, type HotkeyId, type Hotkeys } from "../shared/hotkeys.js";

/** The overlay module (built separately) assigns toggle here; until it does, the overlay hotkey says it is unavailable. */
export const overlayHook: { toggle?: () => void } = {};

export interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Registers the configured accelerators; one that Windows refuses (another app owns it) is reported as failed. */
export class HotkeyManager {
  private active = new Map<HotkeyId, string>();
  failed: HotkeyId[] = [];
  constructor(
    private api: ShortcutApi,
    private actions: Record<HotkeyId, () => void>,
  ) {}
  get registered(): HotkeyId[] {
    return [...this.active.keys()];
  }
  apply(config: Hotkeys) {
    this.dispose();
    if (!config.enabled) return;
    for (const id of hotkeyIds) {
      const accelerator = config.bindings[id];
      let ok = false;
      try {
        ok = this.api.register(accelerator, () => this.actions[id]());
      } catch {
        ok = false;
      }
      if (ok) this.active.set(id, accelerator);
      else this.failed.push(id);
    }
  }
  /** Runs a hotkey's action as if its keys were pressed (the desktop smoke test uses this). */
  press(id: HotkeyId) {
    this.actions[id]();
  }
  dispose() {
    for (const accelerator of this.active.values()) {
      try {
        this.api.unregister(accelerator);
      } catch {
        /* already gone */
      }
    }
    this.active.clear();
    this.failed = [];
  }
}

export interface Foreground {
  pid: number;
  path: string;
}
const norm = (p: string) => path.win32.normalize(p).toLowerCase();
export type Resolved =
  | { kind: "none" }
  | { kind: "ignored" }
  | { kind: "unknown"; exe: string }
  | { kind: "notRunning"; game: Game }
  | { kind: "game"; game: Game; target: ProcessTarget };
/** Which library game (if any) owns the foreground window. Shell, system and Frameforge windows are never games. */
export function resolveForeground(
  fg: Foreground | null,
  games: readonly Game[],
  running: readonly RunningGame[],
  own: { exe: string; systemRoot: string },
): Resolved {
  if (!fg || !fg.path) return { kind: "none" };
  const exe = norm(fg.path);
  const root = norm(own.systemRoot).replace(/[\\/]+$/, "") + "\\";
  if (exe === norm(own.exe) || exe.startsWith(root)) return { kind: "ignored" };
  const game = games.find(
    (g) => g.executablePath && norm(g.executablePath) === exe,
  );
  if (!game) return { kind: "unknown", exe: fg.path };
  const mine = running.filter((r) => r.gameId === game.id);
  const hit = mine.find((r) => r.target.pid === fg.pid) ?? mine[0];
  return hit
    ? { kind: "game", game, target: hit.target }
    : { kind: "notRunning", game };
}

const modeOrder: BoostMode[] = [
  "off",
  "balanced",
  "performance",
  "competitive",
  "custom",
];
export const nextMode = (mode: BoostMode): BoostMode =>
  modeOrder[(modeOrder.indexOf(mode) + 1) % modeOrder.length]!;

export interface HotkeyDeps {
  state(): AppState;
  /** Window owner right now; null when unknown. */
  foreground(): Promise<Foreground | null>;
  running(games: Game[]): Promise<RunningGame[]>;
  live(): boolean;
  start(
    gameId: string,
    target: ProcessTarget,
    skipAdmin: boolean,
  ): Promise<BoostSession | null>;
  stop(): Promise<unknown>;
  setMode(mode: BoostMode): void;
  addGame(exe: string): Promise<void>;
  /** Returns false when the overlay module is not part of this build. */
  toggleOverlay(): boolean;
  /** Windows notification plus tray tooltip; onClick runs when the notification is clicked. */
  notify(text: string, onClick?: { label: string; run: () => void }): void;
  own: { exe: string; systemRoot: string };
}
const messageOf = (e: unknown) =>
  e instanceof Error ? e.message.slice(0, 200) : "Something went wrong.";

/** What each hotkey does. Every outcome ends in one short notification. */
export function hotkeyActions(d: HotkeyDeps): Record<HotkeyId, () => void> {
  const guard = (fn: () => Promise<void> | void) => () => {
    void Promise.resolve()
      .then(fn)
      .catch((e) => d.notify(messageOf(e)));
  };
  return {
    toggleBoost: guard(async () => {
      if (d.live()) {
        await d.stop();
        return d.notify("Boost stopped");
      }
      const state = d.state();
      const fg = await d.foreground();
      const r = resolveForeground(fg, state.games, [], d.own);
      if (r.kind === "none" || r.kind === "ignored")
        return d.notify("Switch to a game first, then press the hotkey.");
      if (r.kind === "unknown")
        return d.notify(
          `${path.win32.basename(r.exe, ".exe")} is not in your library.`,
          { label: "Add to library", run: guard(() => d.addGame(r.exe)) },
        );
      const found = resolveForeground(
        fg,
        state.games,
        await d.running([r.game]),
        d.own,
      );
      if (found.kind !== "game")
        return d.notify(`${r.game.name} is not running.`);
      const session = await d.start(
        found.game.id,
        found.target,
        !state.settings.hotkeys.allowAdmin,
      );
      if (session) d.notify(`Boosting ${found.game.name}`);
    }),
    stopBoost: guard(async () => {
      if (!d.live()) return d.notify("No boost is running.");
      await d.stop();
      d.notify("Boost stopped");
    }),
    toggleOverlay: guard(() => {
      if (!d.toggleOverlay())
        d.notify("The overlay is not available in this build.");
    }),
    cycleMode: guard(() => {
      if (d.live()) return d.notify("Stop the boost before changing the mode.");
      const mode = nextMode(d.state().booster.mode);
      d.setMode(mode);
      d.notify(`Boost mode: ${modeLabels[mode]}`);
    }),
  };
}

const script = `
Add-Type -Namespace F -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, uint p); [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, int f, System.Text.StringBuilder s, ref int n); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);'
[uint32]$p = 0
[void][F.W]::GetWindowThreadProcessId([F.W]::GetForegroundWindow(), [ref]$p)
if ($p -eq 0) { exit 0 }
$h = [F.W]::OpenProcess(0x1000, $false, $p)
if ($h -eq [IntPtr]::Zero) { exit 0 }
$sb = New-Object System.Text.StringBuilder 1024
$n = 1024
if ([F.W]::QueryFullProcessImageName($h, 0, $sb, [ref]$n)) { "$p|$($sb.ToString())" }
[void][F.W]::CloseHandle($h)
`;
/** Process that owns the foreground window (a short PowerShell call; this runs once per key press, never in the background). */
export function foregroundWindow(): Promise<Foreground | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const ps = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise((resolve) => {
    execFile(
      ps,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 8000 },
      (error, stdout) => {
        const [pid, ...rest] = String(stdout).trim().split("|");
        const exe = rest.join("|");
        resolve(
          !error && Number(pid) > 0 && exe
            ? { pid: Number(pid), path: exe }
            : null,
        );
      },
    );
  });
}
