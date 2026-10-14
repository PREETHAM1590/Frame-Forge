import { randomUUID } from "node:crypto";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
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
  type MechanismId,
  type MechanismResult,
  type PowerPlanEntry,
  type ProcessTarget,
  type TimerStatus,
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
// What Frameforge saved before turning on Windows 11's machine-wide timer setting: the exact prior value and when.
const timerKey = "booster.timerGlobal";
type TimerRecord = {
  existed: boolean;
  value: number | null;
  appliedAt: string;
  /** Saved before the change; true until Windows confirmed it. */
  pending?: boolean;
};
const promptSteps = {
  pauseServices: "pause services",
  standbyPurge: "clear the standby list",
} as const;
// The helper reverts in reverse capture order, one result per capture it holds. `indices` maps each saved capture to its
// position in the helper's list (`total` entries, which may include captures Frameforge rejected or that were released).
// Keep only the captures whose revert failed; if the results cannot be aligned, keep everything for a retry.
const pendingCaptures = (
  captured: Captured[],
  reverts: MechanismResult[],
  indices = captured.map((_, i) => i),
  total = captured.length,
) =>
  reverts.length === total
    ? captured.filter(
        (_, i) => reverts[total - 1 - indices[i]!]!.state === "failed",
      )
    : captured;
const capturePolicy =
  "Game Bar capture is managed by an applied optimization (Disable background game capture), so a session leaves it alone.";
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
  abortReason?: string;
  ready?: boolean;
  // Administrator-prompt steps (services, standby list) the helper has not reported a result for yet.
  waiting: Set<MechanismId>;
  // Stop was pressed: the helper's revert may restart paused services behind an administrator prompt.
  stopping?: boolean;
  // Every "captured" line the helper sent (valid or not), and each saved capture's position among them.
  total: number;
  indices: number[];
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
    // elevated: extra time while an administrator prompt is open (services pause at start, restart at the end).
    private timeouts: { start: number; stop: number; elevated?: number } = {
      start: 60000,
      stop: 15000,
    },
  ) {
    this.platform.setOwnedPlan?.(this.ownedPlan());
  }
  get isBusy() {
    return this.busy;
  }
  get active() {
    return this.live !== null;
  }
  get watching() {
    return this.watcher !== undefined;
  }
  private get elevatedMs() {
    return this.timeouts.elevated ?? 330000;
  }
  // The helper may be waiting on an administrator prompt; killing it then would only open a second prompt during recovery.
  private stopMs(live: Live) {
    return (
      this.timeouts.stop +
      (live.waiting.size > 0 ||
      live.captured.some((c) => c.mechanism === "pauseServices")
        ? this.elevatedMs
        : 0)
    );
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
  // Same-named plans Frameforge has not recorded; refreshed by powerPlan("list") and after every plan change.
  private plans: PowerPlanEntry[] = [];
  private async refreshPlans() {
    const owned = this.ownedPlan();
    this.plans = await this.platform
      .listPowerPlans()
      .then((all) => all.filter((p) => p.guid !== owned))
      .catch(() => []);
  }
  private ownedPlan() {
    const guid = this.repo.meta(planKey);
    return typeof guid === "string" ? guid : null;
  }
  private timerRecord(): TimerRecord | null {
    const value = this.repo.meta(timerKey) as TimerRecord | null;
    return value && typeof value.appliedAt === "string" ? value : null;
  }
  // Windows reads the setting at start-up, so it works only after a restart that happened after Frameforge turned it on.
  private timerRestartPending() {
    const record = this.timerRecord();
    if (!record || record.pending) return false;
    return Date.parse(record.appliedAt) > Date.now() - os.uptime() * 1000;
  }
  private timerStatus(caps: BoostCapabilities): TimerStatus {
    return {
      eligible: caps.timerGlobal?.eligible ?? false,
      enabled: caps.timerGlobal?.enabled ?? false,
      ownedByFrameforge: this.timerRecord() !== null,
      restartRequired: this.timerRestartPending(),
    };
  }
  async status(): Promise<{
    session: BoostSession | null;
    capabilities: BoostCapabilities;
    watching: boolean;
    ownedPowerPlan: boolean;
    existingPlans: PowerPlanEntry[];
    timer: TimerStatus;
  }> {
    const base = {
      session: this.live?.session ?? this.repo.boostSession(),
      watching: this.watching,
      ownedPowerPlan: this.ownedPlan() !== null,
      existingPlans: this.plans,
    };
    // Plans and timer support rarely change; avoid a helper spawn on every page refresh.
    if (!this.capabilities || Date.now() - this.capabilities.at > 30000) {
      try {
        this.capabilities = {
          at: Date.now(),
          value: await this.platform.boostCapabilities(
            this.ownedPlan(),
            this.timerRestartPending(),
          ),
        };
      } catch (error) {
        const unavailable = capabilitiesUnavailable(
          `The Windows helper failed: ${text(error)}`,
        );
        return {
          ...base,
          capabilities: unavailable,
          timer: this.timerStatus(unavailable),
        };
      }
    }
    return {
      ...base,
      capabilities: this.withManaged(this.capabilities.value),
      timer: this.timerStatus(this.capabilities.value),
    };
  }
  // Explicit consent from the UI. Turns Windows 11's machine-wide timer setting on (after a restart it lets a game keep a high
  // timer resolution) or puts the saved prior value back. One administrator prompt, never while a session exists.
  timerGlobal(action: "enable" | "restore") {
    return this.exclusive(async () => {
      if (!this.platform.boostAvailable)
        throw new Error(
          "The Windows helper is missing, so the game booster is unavailable.",
        );
      if (this.live || this.repo.boostSession())
        throw new Error(
          "Stop the boost session, or finish or dismiss its recovery, before changing the timer setting.",
        );
      await this.platform.elevation.with("timer", async () => {
        const saved = this.timerRecord();
        if (action === "enable") {
          if (saved)
            throw new Error(
              "Frameforge already turned this on. Turn it back first.",
            );
          const read = await this.platform.timerGlobal({ op: "read" });
          if (read.state === "failed") throw new Error(read.detail);
          if (read.value === 1)
            throw new Error(
              "The setting is already on in Windows, so there is nothing to change.",
            );
          // Saved before the change, so a crash during the prompt never loses the prior value.
          this.repo.setMeta(timerKey, {
            existed: read.existed,
            value: read.value,
            appliedAt: new Date().toISOString(),
            pending: true,
          } satisfies TimerRecord);
          let result;
          try {
            result = await this.platform.timerGlobal({
              op: "enable",
              existed: read.existed,
              value: read.value,
            });
          } catch (error) {
            // Unknown how far it got: the saved prior value stays, so Turn back off can still clean up.
            this.log(
              `Timer setting: the request did not finish (${text(error)}). The prior value was kept for Turn back off.`,
              "failed",
            );
            throw error;
          }
          if (result.state === "applied") {
            this.repo.setMeta(timerKey, {
              existed: read.existed,
              value: read.value,
              appliedAt: new Date().toISOString(),
            } satisfies TimerRecord);
            this.log(result.detail);
            return;
          }
          // Not applied. Unless Windows now says it is on (an unreadable answer), nothing changed: drop the record.
          const after = await this.platform
            .timerGlobal({ op: "read" })
            .catch(() => null);
          // Only a failed write of our own can leave the value on; already-set, conflict, declined and the like mean someone else's.
          if (after?.value === 1 && result.state === "failed") {
            this.repo.setMeta(timerKey, {
              existed: read.existed,
              value: read.value,
              appliedAt: new Date().toISOString(),
            } satisfies TimerRecord);
            this.log(
              `Timer setting: ${result.detail} The setting is on, so Frameforge keeps the prior value for Turn back off.`,
              "failed",
            );
          } else {
            this.repo.setMeta(timerKey, null);
            this.log(`Timer setting not changed. ${result.detail}`, "failed");
          }
          throw new Error(result.detail);
        }
        if (!saved)
          throw new Error("Frameforge has not turned this setting on.");
        const result = await this.platform.timerGlobal({
          op: "restore",
          existed: saved.existed,
          value: saved.value,
        });
        if (result.state === "reverted" || result.state === "conflict") {
          // A conflict means somebody else changed it since; their value is kept and Frameforge lets go.
          this.repo.setMeta(timerKey, null);
          this.log(
            result.detail,
            result.state === "reverted" ? "success" : "failed",
          );
          return;
        }
        this.log(`Timer setting not changed. ${result.detail}`, "failed");
        throw new Error(result.detail);
      });
      this.capabilities = undefined;
      return this.status();
    });
  }
  // The optimization owns the capture value while it is applied; show the mode cards the truth.
  private withManaged(value: BoostCapabilities): BoostCapabilities {
    if (!this.repo.optimizationApplied("capture-off")) return value;
    return {
      ...value,
      mechanisms: value.mechanisms.map((m) =>
        m.id === "gameBarCapture"
          ? { ...m, available: true, active: true, detail: capturePolicy }
          : m,
      ),
    };
  }
  // The owned plan changes what Optimizations can target too (Recommended and Gaming presets), so tell the platform and re-probe.
  private async plansChanged() {
    this.capabilities = undefined;
    this.platform.setOwnedPlan?.(this.ownedPlan());
    await this.platform.probe?.().catch(() => null);
    await this.refreshPlans();
  }
  // Explicit consent from the UI; creates or removes only Frameforge's own copy of the High performance plan.
  powerPlan(
    action: "create" | "remove" | "adopt" | "removeDuplicate" | "list",
    guid?: string,
  ) {
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
      if (action === "list") {
        await this.refreshPlans();
        return this.status();
      }
      if (action === "adopt" || action === "removeDuplicate") {
        await this.refreshPlans();
        const target = this.plans.find((p) => p.guid === guid);
        if (!target)
          throw new Error(
            "That power plan is no longer there, or is not named Frameforge High performance.",
          );
        if (action === "adopt") {
          if (owned) throw new Error("Frameforge already has its plan.");
          this.repo.setMeta(planKey, target.guid);
          this.log(
            `Now using the existing "Frameforge High performance" power plan (${target.guid}). Nothing was changed in Windows.`,
          );
        } else {
          this.log(await this.platform.deleteDuplicatePlan(target.guid));
        }
        await this.plansChanged();
        return this.status();
      }
      if (action === "create") {
        if (owned) throw new Error("Frameforge already created its plan.");
        // Recorded before the helper creates it, so a created plan is never left unrecorded.
        const destination = randomUUID();
        this.repo.setMeta(planKey, destination);
        try {
          await this.platform.createPowerPlan(destination);
        } catch (error) {
          // "plan-not-created": the helper verified no copy exists. Any other outcome keeps the record so Remove can clean up.
          if ((error as { code?: string }).code === "plan-not-created")
            this.repo.setMeta(planKey, null);
          await this.plansChanged();
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
      await this.plansChanged();
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
    requested: CustomMechanisms,
    config: BoosterConfig,
    reason: "manual" | "auto",
  ): Promise<BoostSession> {
    const captured: Captured[] = [];
    // Services and the standby list open an administrator prompt: nothing else may open one while it is pending.
    const prompts = (
      reason === "manual" ? (["pauseServices", "standbyPurge"] as const) : []
    ).filter((id) => requested[id]);
    if (prompts.length) this.platform.elevation.hold("boost");
    // The capture-off optimization writes the same Windows value; applying it twice would let the revert undo it.
    const managed =
      requested.gameBarCapture && this.repo.optimizationApplied("capture-off");
    const mechanisms = managed
      ? { ...requested, gameBarCapture: false }
      : requested;
    let session: BoostSession;
    try {
      session = this.save(
        {
          id: randomUUID(),
          gameId: game.id,
          mode,
          target,
          startedAt: new Date().toISOString(),
          endedAt: null,
          status: "preparing",
          message: `${modeLabels[mode]} mode starting for ${game.name}.${mechanisms.pauseServices && reason === "manual" ? " Windows will ask for administrator approval to pause services." : ""}`,
          mechanisms: managed
            ? [
                {
                  id: "gameBarCapture",
                  state: "skipped",
                  detail: capturePolicy,
                  code: "managed",
                },
              ]
            : [],
          samples: [],
          failed: false,
          abnormal: false,
        },
        captured,
      );
    } catch (error) {
      // The hold must not outlive a failed save (disk error), or no prompt could ever open again.
      if (prompts.length) this.platform.elevation.release("boost");
      throw error;
    }
    this.log(
      `${game.name}: ${modeLabels[mode]} session started (${reason === "auto" ? "auto-boost" : "manual"}).`,
    );
    let channel: SessionChannel;
    try {
      channel = this.platform.spawnSession();
    } catch (error) {
      this.platform.elevation.release("boost");
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
      waiting: new Set<MechanismId>(prompts),
      total: 0,
      indices: [],
    };
    this.live = live;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: BoostSession) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(stopTimer);
        resolve(result);
      };
      // The helper reports ready before it asks for administrator approval, so the start budget has no prompt in it.
      const timer = setTimeout(() => channel.kill(), this.timeouts.start);
      let stopTimer: NodeJS.Timeout | undefined;
      channel.on("event", (raw) => {
        if (this.live !== live) return;
        const isCapture =
          (raw as { event?: unknown } | null)?.event === "captured";
        if (isCapture) live.total++;
        const parsed = SessionEventSchema.safeParse(raw);
        if (!parsed.success) {
          // Fail closed (GC-10): a prior state we cannot save must not be left applied.
          // "stop" makes the helper revert from its in-memory captures; killing it would lose them.
          if (!live.aborted) {
            live.aborted = true;
            live.abortReason = isCapture
              ? "the session helper reported a prior state Frameforge could not save, so the boost was stopped"
              : `the session helper sent a report Frameforge could not read${live.ready ? " during the session" : ""}, so the boost was stopped`;
            // From here the stop timeout governs; the start timer must not kill the helper mid-revert.
            clearTimeout(timer);
            stopTimer = setTimeout(() => channel.kill(), this.stopMs(live));
            this.update(live, {
              message: `Stopping and restoring: ${live.abortReason}.`,
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
              live.captured.push(event.prior);
              live.indices.push(live.total - 1);
              this.update(live, {});
              this.syncGate();
              break;
            case "released": {
              // The change never happened; drop the saved prior so recovery never "undoes" it.
              let index = live.captured.length - 1;
              while (
                index >= 0 &&
                !isDeepStrictEqual(live.captured[index], event.prior)
              )
                index--;
              if (index >= 0) {
                live.captured.splice(index, 1);
                live.indices.splice(index, 1);
                this.update(live, {});
              }
              this.syncGate();
              break;
            }
            case "ready": {
              live.ready = true;
              // A rejected report means the session is already being reverted: never report it as active.
              if (live.aborted) break;
              const applied = live.session.mechanisms.filter(
                (m) => m.state === "applied",
              ).length;
              const waiting = live.waiting.size
                ? ` Waiting for administrator approval to ${[...live.waiting].map((id) => promptSteps[id as keyof typeof promptSteps]).join(" and ")}. The boost works without it, and Stop cancels the request.`
                : "";
              this.update(live, {
                status: "active",
                message: `${
                  applied
                    ? `${modeLabels[mode]} mode active for ${game.name}: ${applied} change(s) applied.`
                    : `${modeLabels[mode]} mode active for ${game.name}, but nothing needed changing on this PC.`
                }${waiting}`,
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
              // A final result replaces the "waiting" row for the same step.
              if (event.event !== "pending")
                live.waiting.delete(event.mechanism);
              this.update(live, {
                mechanisms: [
                  ...live.session.mechanisms.filter(
                    (m) => !(m.state === "pending" && m.id === event.mechanism),
                  ),
                  {
                    id: event.mechanism,
                    state: event.event,
                    detail: event.detail,
                    ...(event.code && { code: event.code }),
                  },
                ].slice(-400),
                message: event.detail,
              });
              this.syncGate();
              if (event.event === "pending") break;
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
        // The helper stopped without reporting its reverts: restore from the saved captures. The session stays marked failed.
        this.live = null;
        this.syncGate();
        this.update(live, {
          status: "recovery-needed",
          failed: true,
          abnormal: true,
          message:
            "The session helper stopped unexpectedly. Restoring the saved state.",
        });
        // Automatic: it must not open an administrator prompt the user did not ask for.
        void this.recoverNow(false, false)
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
        // Xbox and Microsoft Store games need the Xbox services; auto-boost must never open an administrator prompt.
        storeGame: game.source === "xbox" || game.source === "msstore",
        unattended: reason === "auto",
        // Presets leave smart core targeting off on Windows 11 hybrid CPUs; Custom can force it.
        preset: mode !== "custom",
        // Turned on by Frameforge but Windows has not restarted since: a timer request cannot reach the game yet.
        timerRestartPending: this.timerRestartPending(),
      });
    });
  }
  // The gate is held only while a prompt can actually be open: the session waits for an administrator answer, or Stop is
  // reverting paused services. In between (a long session) other administrator work, such as rollbacks, is not blocked.
  private syncGate() {
    const live = this.live;
    const needed =
      !!live &&
      (live.waiting.size > 0 ||
        (!!live.stopping &&
          live.captured.some((c) => c.mechanism === "pauseServices")));
    if (needed) {
      try {
        this.platform.elevation.hold("boost");
      } catch {
        /* Another prompt was open first; the earlier holder keeps it. */
      }
    } else this.platform.elevation.release("boost");
  }
  private end(
    live: Live,
    reason: keyof typeof endReasons,
    reverts: MechanismResult[],
    detail?: string,
  ) {
    this.live = null;
    this.platform.elevation.release("boost");
    this.capabilities = undefined;
    const count = (state: MechanismResult["state"]) =>
      reverts.filter((r) => r.state === state).length;
    // Fewer results than captures means the helper's revert stopped early: never report that as restored.
    const incomplete = reverts.length < live.total;
    const failed = count("failed") + (incomplete ? 1 : 0);
    const why = live.aborted
      ? (live.abortReason ?? "a helper report was rejected")
      : reason === "start-failed" && detail
        ? `the boost could not start: ${detail}`
        : endReasons[reason];
    // Only failed reverts stay saved for a retry, so a retry never repeats a completed one (for example a second resume).
    live.captured = pendingCaptures(
      live.captured,
      reverts,
      live.indices,
      live.total,
    );
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
      abnormal: !!live.aborted || reason === "start-failed",
      endedAt: failed ? null : now.toISOString(),
      mechanisms: [...live.session.mechanisms, ...reverts].slice(-400),
      message: incomplete
        ? `Session ended because ${why}, but the helper did not report every revert${detail && reason !== "start-failed" ? ` (${detail})` : ""}. Retry recovery.`
        : failed
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
    live.stopping = true;
    this.syncGate();
    live.channel.send({ command: "stop" });
    const result = await Promise.race([live.ended, delay(this.stopMs(live))]);
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
  // App start: restores everything that needs no administrator rights and leaves paused services as "recovery needed".
  recoverAtStartup(): Promise<BoostSession | null> {
    return this.exclusive(() => this.recoverNow(false, false));
  }
  private async recoverNow(
    dismiss = false,
    interactive = true,
  ): Promise<BoostSession | null> {
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
    const prompts =
      interactive && captured.some((c) => c.mechanism === "pauseServices");
    if (prompts) this.platform.elevation.hold("recover");
    try {
      const reverts = captured.length
        ? await this.platform.boostRecover(
            captured,
            this.ownedPlan(),
            interactive,
          )
        : [];
      const failed = reverts.filter((r) => r.state === "failed");
      const conflicts = reverts.filter((r) => r.state === "conflict").length;
      const remaining = pendingCaptures(captured, reverts);
      // A session that ended abnormally (helper crash, rejected report) stays failed even when recovery succeeds;
      // one that only had failed reverts is resolved once they are restored.
      const abnormal = session.abnormal;
      const result = this.save(
        {
          ...session,
          status: failed.length ? "recovery-needed" : "ended",
          failed: failed.length > 0 || abnormal,
          endedAt: failed.length ? null : new Date().toISOString(),
          mechanisms: [...session.mechanisms, ...reverts].slice(-400),
          message: failed.length
            ? `Recovery could not restore ${failed.length} change(s): ${failed[0]!.detail}`
            : `${abnormal ? "The boost did not finish normally. " : ""}Recovered: ${reverts.length} saved change(s) checked, ${conflicts} external change(s) kept.`,
        },
        remaining,
      );
      this.log(
        result.message,
        failed.length || abnormal ? "failed" : "success",
      );
      return result;
    } catch (error) {
      const result = finish({
        status: "recovery-needed",
        failed: true,
        message: `Recovery failed: ${text(error)}. Retry, or dismiss to keep the current state.`,
      });
      this.log(result.message, "failed");
      return result;
    } finally {
      if (prompts) this.platform.elevation.release("recover");
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
