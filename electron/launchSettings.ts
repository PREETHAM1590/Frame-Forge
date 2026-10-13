import {
  type LaunchPreview,
  type LaunchResult,
  type LaunchSetting,
  type LaunchStatus,
} from "../shared/contracts.js";
import type { Repository } from "./repository.js";
import type { Platform } from "./platform.js";
export const launchSettings: LaunchSetting[] = [
  "gpuPreference",
  "fullscreenOptimizations",
];
export const launchLabels: Record<LaunchSetting, string> = {
  gpuPreference: "High-performance GPU preference",
  fullscreenOptimizations: "Fullscreen optimizations off",
};
const warnings: Record<LaunchSetting, string> = {
  gpuPreference:
    "Windows reads this the next time the game starts. Only the GPU preference for this one executable changes; other flags in the same value are kept. It stays until you revert it.",
  fullscreenOptimizations:
    "Advanced. Windows reads this the next time the game starts. Some games lose Auto HDR, variable refresh rate or windowed-game latency improvements. Other compatibility flags for this executable are kept. It stays until you revert it.",
};
// What Frameforge saved before changing the value: the exact prior (absent included) and the value it wrote.
type Record_ = {
  exe: string;
  existed: boolean;
  value: string | null;
  applied: string;
  at: string;
  // Set until the apply is confirmed: a record that is still pending means Windows may hold a half-applied value.
  pending?: boolean;
};
const key = (gameId: string, setting: LaunchSetting) =>
  `launch:${gameId}:${setting}`;
const text = (error: unknown) =>
  (error instanceof Error ? error.message : "Unknown error").slice(0, 500);
export class LaunchSettingsService {
  private busy = false;
  constructor(
    private repo: Repository,
    private platform: Platform,
  ) {}
  get isBusy() {
    return this.busy;
  }
  /** True when Frameforge still holds a prior value for this game (it must be reverted before the game is removed). */
  hasRecords(gameId: string) {
    return launchSettings.some((s) => this.record(gameId, s) !== null);
  }
  private record(gameId: string, setting: LaunchSetting): Record_ | null {
    const value = this.repo.meta(key(gameId, setting)) as Record_ | null;
    return value && typeof value.exe === "string" ? value : null;
  }
  private game(gameId: string) {
    const game = this.repo.state().games.find((g) => g.id === gameId);
    if (!game) throw new Error("Game not found");
    return game;
  }
  private call(
    setting: LaunchSetting,
    exe: string,
    op: "read" | "apply" | "revert",
    saved?: Record_,
  ): Promise<LaunchResult> {
    return this.platform.launchSetting({
      setting,
      exe,
      op,
      ...(saved && {
        existed: saved.existed,
        value: saved.value,
        applied: saved.applied,
      }),
    });
  }
  async status(gameId: string): Promise<LaunchStatus> {
    const game = this.game(gameId);
    const gameExe = game.executablePath;
    const settings: LaunchStatus["settings"] = [];
    for (const setting of launchSettings) {
      const saved = this.record(gameId, setting);
      // A saved prior belongs to the executable it was written for, not to whatever path the game has now.
      const exe = saved?.exe ?? gameExe;
      const row = (
        state: LaunchStatus["settings"][number]["state"],
        detail: string,
        current: string | null = null,
      ) => ({
        setting,
        state,
        detail,
        current,
        canRevert: !!saved && this.platform.boostAvailable,
        appliedAt: saved?.at ?? null,
      });
      if (!this.platform.boostAvailable) {
        settings.push(
          row("unsupported", "Launch settings need the Windows helper."),
        );
        continue;
      }
      if (!exe) {
        settings.push(
          row(
            "unsupported",
            "Frameforge does not know this game's executable. Add the game by its .exe file to use launch settings.",
          ),
        );
        continue;
      }
      try {
        const read = await this.call(setting, exe, "read");
        if (saved?.pending)
          settings.push(
            row(
              "recovery-needed",
              "A change to this value may be half applied and could not be undone. Revert restores the value from before; use Forget to keep what Windows has now.",
              read.current,
            ),
          );
        else if (saved) {
          // Frameforge's own change: still in place, or changed outside since.
          const inPlace =
            read.state === "already-set" && read.current === saved.applied;
          settings.push(
            row(
              inPlace ? "applied" : "conflict",
              inPlace
                ? "Set by Frameforge. Revert restores the value from before."
                : "The value was changed outside Frameforge since it was set. Revert keeps that change; use Forget to drop Frameforge's saved value.",
              read.current,
            ),
          );
        } else
          settings.push({
            ...row(
              read.state === "ready" ||
                read.state === "already-set" ||
                read.state === "unsupported"
                ? read.state
                : "failed",
              read.state === "already-set"
                ? `${read.detail} It was not set by Frameforge, so there is nothing to revert.`
                : read.detail,
              read.current,
            ),
            canRevert: false,
          });
      } catch (error) {
        settings.push(row("failed", `Could not be read: ${text(error)}`));
      }
    }
    return { gameId, executable: gameExe, settings };
  }
  async preview(
    gameId: string,
    setting: LaunchSetting,
    action: "apply" | "revert",
  ): Promise<LaunchPreview> {
    const game = this.game(gameId);
    const exe = game.executablePath;
    if (action === "apply") {
      // Only an apply needs the game's current executable; a revert uses the one saved with the prior.
      if (!exe)
        throw new Error("Frameforge does not know this game's executable.");
      const read = await this.call(setting, exe, "read");
      if (read.state !== "ready") throw new Error(read.detail);
      return {
        setting,
        action,
        exe,
        before: read.current,
        after: read.after,
        warning: warnings[setting],
      };
    }
    const saved = this.record(gameId, setting);
    if (!saved) throw new Error("Frameforge has not changed this setting.");
    const read = await this.call(setting, saved.exe, "read");
    return {
      setting,
      action,
      exe: saved.exe,
      before: read.current,
      after: saved.value,
      warning:
        "Restores exactly the value from before Frameforge changed it, and only if nobody has changed it since.",
    };
  }
  async apply(
    gameId: string,
    setting: LaunchSetting,
    action: "apply" | "revert" | "forget",
  ): Promise<LaunchStatus> {
    if (this.busy)
      throw new Error("Wait for the launch setting change to finish.");
    this.busy = true;
    try {
      const game = this.game(gameId);
      const exe = game.executablePath;
      const label = `${launchLabels[setting]} for ${game.name}`;
      const saved = this.record(gameId, setting);
      if (action === "forget") {
        if (!saved) throw new Error("Frameforge has not changed this setting.");
        this.repo.setMeta(key(gameId, setting), null);
        this.log(
          `${label}: Frameforge's saved prior value was dropped. Windows was not changed.`,
        );
        return this.status(gameId);
      }
      if (!this.platform.boostAvailable)
        throw new Error("Launch settings need the Windows helper.");
      if (action === "apply") {
        if (!exe)
          throw new Error("Frameforge does not know this game's executable.");
        if (saved)
          throw new Error(
            "Frameforge already changed this setting. Revert it first.",
          );
        const read = await this.call(setting, exe, "read");
        if (read.state !== "ready" || read.after === null)
          throw new Error(read.detail);
        // GC-10: the prior value is saved before Windows changes.
        const record: Record_ = {
          exe,
          existed: read.existed,
          value: read.current,
          applied: read.after,
          at: new Date().toISOString(),
          pending: true,
        };
        this.repo.setMeta(key(gameId, setting), record);
        let result: LaunchResult | undefined;
        let failure: unknown;
        try {
          result = await this.call(setting, exe, "apply");
        } catch (error) {
          failure = error;
        }
        if (result?.state === "applied") {
          this.repo.setMeta(key(gameId, setting), {
            ...record,
            pending: undefined,
          });
          this.log(
            `${label}: set. Prior value saved; use Revert to restore it.`,
          );
        } else {
          // Unknown how far it got: an exact-prior revert is safe whether or not the value was written. Only a confirmed
          // revert lets the saved prior go; otherwise it stays so Revert (or Forget) remains available.
          const why = result?.detail ?? text(failure);
          const undone = await this.call(setting, exe, "revert", record).catch(
            () => null,
          );
          if (undone?.state === "reverted") {
            this.repo.setMeta(key(gameId, setting), null);
            this.log(`${label}: could not be set. ${why}`, "failed");
            throw new Error(why);
          }
          this.log(
            `${label}: could not be set and the change could not be undone (${why}). The saved prior value was kept; use Revert.`,
            "failed",
          );
          throw new Error(
            `${why} The value may be half applied and could not be undone; Revert is available in Launch settings.`,
          );
        }
      } else {
        if (!saved) throw new Error("Frameforge has not changed this setting.");
        const result = await this.call(setting, saved.exe, "revert", saved);
        if (result.state === "reverted") {
          this.repo.setMeta(key(gameId, setting), null);
          this.log(`${label}: reverted. ${result.detail}`);
        } else {
          // Conflict or failure: keep the record so the user can retry or forget it.
          this.log(`${label}: not reverted. ${result.detail}`, "failed");
          if (result.state === "failed") throw new Error(result.detail);
        }
      }
      return this.status(gameId);
    } finally {
      this.busy = false;
    }
  }
  private log(message: string, status: "success" | "failed" = "success") {
    try {
      this.repo.log("Launch settings", message.slice(0, 1000), status);
    } catch {
      /* A logging failure must not hide the outcome of the Windows change. */
    }
  }
}
