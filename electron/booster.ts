import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BoostSession, ProcessTarget } from "../shared/contracts.js";
import type { Repository } from "./repository.js";
import type { Platform } from "./platform.js";
const text = (error: unknown) =>
  (error instanceof Error ? error.message : "Unknown error").slice(0, 500);
export class BoostEngine {
  private busy = false;
  constructor(
    private repo: Repository,
    private platform: Platform,
  ) {}
  get isBusy() {
    return this.busy;
  }
  private save(
    session: BoostSession,
    status: BoostSession["status"],
    message: string,
  ) {
    const next = { ...session, status, message: message.slice(0, 1000) };
    this.repo.saveBoostSession(next);
    return next;
  }
  private log(message: string, status: "success" | "failed" = "success") {
    try {
      this.repo.log("Game booster", message, status);
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
  start(gameId: string, target: ProcessTarget): Promise<BoostSession> {
    return this.exclusive(async () => {
      const game = this.repo.state().games.find((g) => g.id === gameId);
      if (!game) throw new Error("Game not found");
      if (this.repo.boostSession())
        throw new Error(
          "Restore the current boosted game before starting another.",
        );
      const running = await this.platform.gameProcesses(game);
      if (!running.some((p) => isDeepStrictEqual(p, target)))
        throw new Error(
          "The selected process is no longer a running target for this game. Find running processes again.",
        );
      if (target.priority !== "Normal")
        throw new Error(
          "Only a process running at Normal priority can be boosted.",
        );
      let session: BoostSession = {
        id: randomUUID(),
        gameId,
        target,
        startedAt: new Date().toISOString(),
        status: "preparing",
        message: "Original process priority saved; raising priority.",
      };
      this.repo.saveBoostSession(session);
      try {
        const snapshot = await this.platform.boostStart(target);
        session = this.save(
          { ...session, target: snapshot },
          "active",
          "Game priority raised to Above normal and verified.",
        );
        this.log(`${game.name}: priority raised to Above normal.`);
        return session;
      } catch (error) {
        try {
          await this.platform.boostStop(target);
        } catch (stopError) {
          const failed = this.save(
            session,
            "recovery-needed",
            `Boost failed (${text(error)}) and the original priority could not be confirmed: ${text(stopError)}`,
          );
          this.log(failed.message, "failed");
          return failed;
        }
        this.save(session, "ended", `Boost failed: ${text(error)}`);
        this.log(
          `${game.name}: boost failed and nothing was changed. ${text(error)}`,
          "failed",
        );
        throw error;
      }
    });
  }
  stop(): Promise<BoostSession | null> {
    return this.exclusive(async () => {
      const session = this.repo.boostSession();
      if (!session) return null;
      this.save(
        session,
        "restoring",
        "Restoring the original process priority.",
      );
      try {
        const ended = this.save(
          session,
          "ended",
          await this.platform.boostStop(session.target),
        );
        this.log(ended.message);
        return ended;
      } catch (error) {
        const failed = this.save(
          session,
          "recovery-needed",
          `Restore failed: ${text(error)}`,
        );
        this.log(failed.message, "failed");
        return failed;
      }
    });
  }
}
