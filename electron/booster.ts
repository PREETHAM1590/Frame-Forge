import { randomUUID } from "node:crypto";
import {
  SessionEventSchema,
  modeMechanisms,
  type BoostCapabilities,
  type BoostMode,
  type BoostSession,
  type BoosterConfig,
  type Captured,
  type CustomMechanisms,
  type Game,
  type MechanismResult,
  type ProcessTarget,
} from "../shared/contracts.js";
import type { Repository } from "./repository.js";
import {
  capabilitiesUnavailable,
  type Platform,
  type SessionChannel,
} from "./platform.js";
const text = (error: unknown) =>
  (error instanceof Error ? error.message : "Unknown error").slice(0, 500);
const key = (t: ProcessTarget) => `${t.pid}|${t.startTime}`;
const planKey = "booster.powerPlan";
// The helper reverts in reverse capture order, one result per capture. Keep only the captures whose revert failed.
const pendingCaptures = (captured: Captured[], reverts: MechanismResult[]) =>
  reverts.length === captured.length
    ? captured.filter(
        (_, i) => reverts[captured.length - 1 - i]!.state === "failed",
      )
    : captured;
const delay = (ms: number) =>
  new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
export const modeLabels: Record<BoostMode, string> = {
  off: "Off",
  balanced: "Balanced",
  performance: "Performance",
  competitive: "Competitive",
  custom: "Custom",
};
const endReasons = {
  "game-exited": "the game exited",
  stop: "it was stopped",
  "parent-exited": "Frameforge closed",
  "stdin-closed": "Frameforge closed",
  "start-failed": "the boost could not start",
} as const;
type Live = {
  channel: SessionChannel;
  session: BoostSession;
  captured: Captured[];
  game: string;
  ended: Promise<BoostSession>;
  // Set when a helper report was rejected; the session is being reverted and is never reported as active.
  aborted?: boolean;
};
export class BoostEngine {
  private busy = false;
  private live: Live | null = null;
  private watcher: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private lastPollError = "";
  private capabilities: { at: number; value: BoostCapabilities } | undefined;
  // Process instances already auto-boosted (or stopped), so the watcher never restarts them.
  private seen = new Set<string>();
  constructor(
    private repo: Repository,
    private platform: Platform,
    private notify: (session: BoostSession) => void = () => {},
    private timeouts = { start: 60000, stop: 15000 },
  ) {}
  get isBusy() {
    return this.busy;
  }
  get active() {
    return this.live !== null;
  }
  get watching() {
    return this.watcher !== undefined;
  }
  private save(session: BoostSession, captured: Captured[]) {
    const next = { ...session, message: session.message.slice(0, 1000) };
    this.repo.saveBoostSession(next, captured);
    try {
      this.notify(next);
    } catch {
      /* A closed window must not interrupt the session. */
    }
    return next;
  }
  private update(live: Live, patch: Partial<BoostSession>) {
    live.session = this.save({ ...live.session, ...patch }, live.captured);
  }
  private log(message: string, status: "success" | "failed" = "success") {
    try {
      this.repo.log("Game booster", message.slice(0, 1000), status);
    } catch {
      /* A logging failure must not hide the outcome of the Windows change. */
    }
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Wait for the game booster to finish.");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  // GUID of the plan Frameforge created with the user's consent; only the helper's reply ever writes it.
  private ownedPlan() {
    return this.repo.meta(planKey);
  }
  async status(): Promise<{
    session: BoostSession | null;
    capabilities: BoostCapabilities;
    watching: boolean;
    ownedPowerPlan: boolean;
  }> {
    const base = {
      session: this.live?.session ?? this.repo.boostSession(),
      watching: this.watching,
      ownedPowerPlan: this.ownedPlan() !== null,
    };
    // Plans and timer support rarely change; avoid a helper spawn on every page refresh.
    if (!this.capabilities || Date.now() - this.capabilities.at > 30000) {
      try {
        this.capabilities = {
          at: Date.now(),
          value: await this.platform.boostCapabilities(this.ownedPlan()),
        };
      } catch (error) {
        return {
          ...base,
          capabilities: capabilitiesUnavailable(
            `The Windows helper failed: ${text(error)}`,
          ),
        };
      }
    }
    return { ...base, capabilities: this.capabilities.value };
  }
  // Explicit consent from the UI; creates or removes only Frameforge's own copy of the High performance plan.
  powerPlan(action: "create" | "remove") {
    return this.exclusive(async () => {
      if (!this.platform.boostAvailable)
        throw new Error(
          "The Windows helper is missing, so the game booster is unavailable.",
        );
      // A pending recovery may still need the plan, so it cannot change underneath it.
      if (this.live || this.repo.boostSession())
        throw new Error(
          "Stop the boost session, or finish or dismiss its recovery, before changing power plans.",
        );
      const owned = this.ownedPlan();
      if (action === "create") {
        if (owned) throw new Error("Frameforge already created its plan.");
        // Recorded before the helper creates it, so a created plan is never left unrecorded.
        const destination = randomUUID();
        this.repo.setMeta(planKey, destination);
        try {
          await this.platform.createPowerPlan(destination);
        } catch (error) {
          // The helper replied (code set): it verified nothing was left behind. Otherwise keep the record so Remove can clean up.
          if ((error as { code?: string }).code)
            this.repo.setMeta(planKey, null);
          this.capabilities = undefined;
          throw error;
        }
        this.log(
          `Created the "Frameforge High performance" power plan (${destination}). The active plan was not changed; boost sessions switch to it and back.`,
        );
      } else {
        if (!owned) throw new Error("Frameforge has not created a plan.");
        const message = await this.platform.deletePowerPlan(owned);
        this.repo.setMeta(planKey, null);
        this.log(message);
      }
      this.capabilities = undefined;
      return this.status();
    });
  }
  start(
    gameId: string,
    reason: "manual" | "auto",
    target?: ProcessTarget,
  ): Promise<BoostSession | null> {
    return this.exclusive(async () => {
      if (!this.platform.boostAvailable)
        throw new Error(
          "The Windows helper is missing, so the game booster is unavailable.",
        );
      const state = this.repo.state();
      const game = state.games.find((g) => g.id === gameId);
      if (!game) throw new Error("Game not found");
      if (this.live || this.repo.boostSession())
        throw new Error(
          "Stop or recover the current boost session before starting another.",
        );
      const mode =
        game.boostMode === "global" ? state.booster.mode : game.boostMode;
      if (mode === "off") {
        if (reason === "auto") return null;
        throw new Error(
          `Booster mode is Off for ${game.name}. Choose a mode first.`,
        );
      }
      target ??= (await this.platform.runningGames([game]))[0]?.target;
      if (!target)
        throw new Error(
          "Start the game first. Frameforge boosts a game that is already running.",
        );
      const mechanisms =
        mode === "custom" ? state.booster.custom : modeMechanisms[mode];
      return this.run(game, mode, target, mechanisms, state.booster, reason);
    });
  }
  private run(
    game: Game,
    mode: BoostMode,
    target: ProcessTarget,
    mechanisms: CustomMechanisms,
    config: BoosterConfig,
    reason: "manual" | "auto",
  ): Promise<BoostSession> {
    const captured: Captured[] = [];
    const session = this.save(
      {
        id: randomUUID(),
        gameId: game.id,
        mode,
        target,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "preparing",
        message: `${modeLabels[mode]} mode starting for ${game.name}.`,
        mechanisms: [],
        samples: [],
        failed: false,
      },
      captured,
    );
    this.log(
      `${game.name}: ${modeLabels[mode]} session started (${reason === "auto" ? "auto-boost" : "manual"}).`,
    );
    let channel: SessionChannel;
    try {
      channel = this.platform.spawnSession();
    } catch (error) {
      this.save(
        {
          ...session,
          status: "ended",
          endedAt: new Date().toISOString(),
          message: `Boost could not start: ${text(error)}`,
          failed: true,
        },
        captured,
      );
      throw error;
    }
    let resolveEnded!: (session: BoostSession) => void;
    const live: Live = {
      channel,
      session,
      captured,
      game: game.name,
      ended: new Promise((resolve) => (resolveEnded = resolve)),
    };
    this.live = live;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: BoostSession) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => channel.kill(), this.timeouts.start);
      channel.on("event", (raw) => {
        if (this.live !== live) return;
        const parsed = SessionEventSchema.safeParse(raw);
        if (!parsed.success) {
          // Fail closed (GC-10): a prior state we cannot save must not be left applied.
          // "stop" makes the helper revert from its in-memory captures; killing it would lose them.
          if (!live.aborted) {
            live.aborted = true;
            this.update(live, {
              message:
                "The session helper reported state Frameforge could not save. Stopping the session and restoring.",
            });
            this.log(
              `${game.name}: invalid session helper report; the session was stopped and reverted.`,
              "failed",
            );
            channel.send({ command: "stop" });
          }
          return;
        }
        const event = parsed.data;
        try {
          switch (event.event) {
            case "captured":
              // GC-10: persisted as soon as the helper reports it, before its change is verified.
              captured.push(event.prior);
              this.update(live, {});
              break;
            case "ready": {
              // A rejected report means the session is already being reverted: never report it as active.
              if (live.aborted) break;
              const applied = live.session.mechanisms.filter(
                (m) => m.state === "applied",
              ).length;
              this.update(live, {
                status: "active",
                message: applied
                  ? `${modeLabels[mode]} mode active for ${game.name}: ${applied} change(s) applied.`
                  : `${modeLabels[mode]} mode active for ${game.name}, but nothing needed changing on this PC.`,
              });
              settle(live.session);
              break;
            }
            case "sample": {
              const sample = {
                at: event.at,
                systemCpuPercent: event.systemCpuPercent,
                availableMemoryBytes: event.availableMemoryBytes,
                gameWorkingSetBytes: event.gameWorkingSetBytes,
              };
              this.update(live, {
                samples: [...live.session.samples, sample].slice(-200),
              });
              break;
            }
            case "ended":
              this.end(live, event.reason, event.reverts, event.detail);
              resolveEnded(live.session);
              settle(live.session);
              break;
            default:
              this.update(live, {
                mechanisms: [
                  ...live.session.mechanisms,
                  {
                    id: event.mechanism,
                    state: event.event,
                    detail: event.detail,
                  },
                ].slice(-400),
                message: event.detail,
              });
              this.log(
                `${game.name}: ${event.mechanism} ${event.event}. ${event.detail}`,
                event.event === "failed" ? "failed" : "success",
              );
          }
        } catch (error) {
          this.log(
            `${game.name}: session state could not be saved: ${text(error)}`,
            "failed",
          );
        }
      });
      channel.on("exit", () => {
        if (this.live !== live) return;
        // The helper stopped without reporting its reverts: restore from the saved captures.
        this.live = null;
        this.update(live, {
          status: "recovery-needed",
          message:
            "The session helper stopped unexpectedly. Restoring the saved state.",
        });
        void this.recoverNow()
          .catch(() => null)
          .then((result) => {
            const final = result ?? live.session;
            resolveEnded(final);
            settle(final);
          });
      });
      channel.send({
        command: "start",
        gamePid: target.pid,
        gameStartTime: target.startTime,
        gamePath: target.executablePath,
        mechanisms,
        background: config.background,
        parentPid: process.pid,
        ownedPlan: this.ownedPlan(),
      });
    });
  }
  private end(
    live: Live,
    reason: keyof typeof endReasons,
    reverts: MechanismResult[],
    detail?: string,
  ) {
    this.live = null;
    this.capabilities = undefined;
    const count = (state: MechanismResult["state"]) =>
      reverts.filter((r) => r.state === state).length;
    const failed = count("failed");
    const why = live.aborted
      ? "the session helper reported a prior state Frameforge could not save, so the boost was stopped"
      : reason === "start-failed" && detail
        ? `the boost could not start: ${detail}`
        : endReasons[reason];
    // Only failed reverts stay saved for a retry, so a retry never repeats a completed one (for example a second resume).
    live.captured = pendingCaptures(live.captured, reverts);
    const now = new Date();
    const minutes = Math.round(
      (now.getTime() - Date.parse(live.session.startedAt)) / 60000,
    );
    const samples = live.session.samples;
    const average = (pick: (s: (typeof samples)[number]) => number) =>
      samples.reduce((sum, s) => sum + pick(s), 0) / samples.length;
    const snapshot = samples.length
      ? ` System snapshot, not FPS: average CPU ${average((s) => s.systemCpuPercent).toFixed(0)}%, average available RAM ${(average((s) => s.availableMemoryBytes) / 1024 ** 3).toFixed(1)} GB.`
      : "";
    const summary = `Restored ${count("reverted")}, kept ${count("conflict")} external change(s), failed ${failed}.`;
    this.update(live, {
      status: failed ? "recovery-needed" : "ended",
      failed: failed > 0 || !!live.aborted || reason === "start-failed",
      endedAt: failed ? null : now.toISOString(),
      mechanisms: [...live.session.mechanisms, ...reverts].slice(-400),
      message: failed
        ? `Session ended because ${why}, but ${failed} change(s) could not be restored. Retry recovery.`
        : `Session ended because ${why}. ${summary}`,
    });
    this.log(
      `${live.game}: session ended after ${minutes} min because ${why}. ${summary}${snapshot}`,
      failed || live.aborted || reason === "start-failed"
        ? "failed"
        : "success",
    );
  }
  async stop(): Promise<BoostSession | null> {
    const live = this.live;
    if (!live) return this.recover();
    this.seen.add(key(live.session.target));
    this.update(live, {
      status: "restoring",
      message: "Restoring the saved state.",
    });
    live.channel.send({ command: "stop" });
    const result = await Promise.race([live.ended, delay(this.timeouts.stop)]);
    if (result) return result;
    // The exit handler restores from the saved captures.
    live.channel.kill();
    return (
      (await Promise.race([live.ended, delay(this.timeouts.stop)])) ??
      this.repo.boostSession()
    );
  }
  recover(dismiss = false): Promise<BoostSession | null> {
    return this.exclusive(() => this.recoverNow(dismiss));
  }
  private async recoverNow(dismiss = false): Promise<BoostSession | null> {
    if (this.live) return this.live.session;
    const record = this.repo.boostRecord();
    if (!record) return null;
    const { session, captured } = record;
    const finish = (patch: Partial<BoostSession>) =>
      this.save({ ...session, ...patch }, captured);
    if (dismiss) {
      const result = finish({
        status: "ended",
        endedAt: new Date().toISOString(),
        message:
          "Recovery dismissed. Any remaining changes were left as they are.",
        failed: true,
      });
      this.log(result.message, "failed");
      return result;
    }
    try {
      const reverts = captured.length
        ? await this.platform.boostRecover(captured, this.ownedPlan())
        : [];
      const failed = reverts.filter((r) => r.state === "failed");
      const conflicts = reverts.filter((r) => r.state === "conflict").length;
      const remaining = pendingCaptures(captured, reverts);
      const result = this.save(
        {
          ...session,
          status: failed.length ? "recovery-needed" : "ended",
          failed: failed.length > 0,
          endedAt: failed.length ? null : new Date().toISOString(),
          mechanisms: [...session.mechanisms, ...reverts].slice(-400),
          message: failed.length
            ? `Recovery could not restore ${failed.length} change(s): ${failed[0]!.detail}`
            : `Recovered: ${reverts.length} saved change(s) checked, ${conflicts} external change(s) kept.`,
        },
        remaining,
      );
      this.log(result.message, failed.length ? "failed" : "success");
      return result;
    } catch (error) {
      const result = finish({
        status: "recovery-needed",
        failed: true,
        message: `Recovery failed: ${text(error)}. Retry, or dismiss to keep the current state.`,
      });
      this.log(result.message, "failed");
      return result;
    }
  }
  configure() {
    const on =
      this.platform.boostAvailable && this.repo.state().booster.autoBoost;
    if (on && !this.watcher) {
      // ponytail: 5 s polling; WMI process-start events (Win32_ProcessStartTrace) if start latency matters.
      this.watcher = setInterval(() => void this.poll(), 5000);
      this.watcher.unref?.();
    } else if (!on && this.watcher) {
      clearInterval(this.watcher);
      this.watcher = undefined;
    }
  }
  async poll() {
    if (this.polling || this.busy || this.live || this.repo.boostSession())
      return;
    const games = this.repo.state().games;
    if (!games.length) return;
    this.polling = true;
    try {
      const found = (await this.platform.runningGames(games)).find(
        (f) => !this.seen.has(key(f.target)),
      );
      if (!found) return;
      if (this.seen.size > 1000) this.seen.clear();
      this.seen.add(key(found.target));
      await this.start(found.gameId, "auto", found.target);
      this.lastPollError = "";
    } catch (error) {
      if (text(error) !== this.lastPollError)
        this.log(`Auto-boost: ${text(error)}`, "failed");
      this.lastPollError = text(error);
    } finally {
      this.polling = false;
    }
  }
  dispose() {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = undefined;
  }
}
