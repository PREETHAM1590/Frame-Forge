import { randomUUID } from "node:crypto";
import {
  BenchReportSchema,
  FpsEventSchema,
  FpsSummarySchema,
  type BenchReport,
  type AppEvent,
  type FpsStatus,
  type FpsSummary,
  type Game,
} from "../shared/contracts.js";
import { FpsAccumulator } from "../shared/fps.js";
import type { Platform, SessionChannel } from "./platform.js";
/** Shortest capture worth keeping: seconds, and frames (so a paused game does not leave a meaningless row). */
export const minSummarySeconds = 10;
export const minSummaryFrames = 120;
const keepPerGame = 30;
/** Seconds after the first reading without a single frame before the page is told why. */
const noFramesAfter = 15;
const summaryKey = (gameId: string) => `fps:${gameId}`;
const runsKey = (gameId: string) => `bench:runs:${gameId}`;
const reportsKey = (gameId: string) => `bench:reports:${gameId}`;
const keepRuns = 40;
const keepReports = 20;
export interface FpsDeps {
  games(): Game[];
  /** Is Game Mode active for this game right now? */
  boostOn(gameId: string): boolean;
  meta(key: string): unknown;
  setMeta(key: string, value: unknown): void;
  /** Activity row for a saved summary. */
  log(label: string, message: string): void;
  notify(event: AppEvent): void;
  now?: () => number;
}
type Idle = FpsStatus["state"];
/**
 * Game Monitor. One capture at a time. The capture itself runs in an elevated helper child that Windows asks the user to approve;
 * this class only talks to the helper's unelevated side (`--fps`), holds the shared administrator-prompt gate while the prompt is open,
 * and turns the frame times into live numbers and one saved summary per capture.
 */
export class FpsService {
  private channel: SessionChannel | null = null;
  private state: Idle = "idle";
  private game: Game | null = null;
  private code: string | null = null;
  private detail = "No FPS capture is running.";
  private acc = new FpsAccumulator();
  private startedAt = 0;
  private endedAt = 0;
  private lastFps: number | null = null;
  private usage: FpsStatus["usage"] = null;
  private boostSeen = new Set<boolean>();
  private saved: FpsSummary | null = null;
  private waiters: Array<() => void> = [];
  private benchSeconds: number | null = null;
  private benchTimer: ReturnType<typeof setTimeout> | null = null;
  private usageSum = { cpu: 0, gpu: 0, cpuN: 0, gpuN: 0 };
  constructor(
    private platform: Platform,
    private deps: FpsDeps,
  ) {}
  get active() {
    return this.state === "starting" || this.state === "capturing";
  }
  /** Frame statistics of the capture that is running now, for Smart mode; null without one (or before enough frames). */
  liveStats(): { avg: number; low1: number | null } | null {
    const avg = this.acc.avgFps;
    return this.state === "capturing" && avg !== null && this.acc.frames >= 300
      ? { avg, low1: this.acc.low1Fps }
      : null;
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  async status(): Promise<FpsStatus> {
    return this.snapshot(await this.running());
  }
  private async running(): Promise<string[]> {
    try {
      const games = this.deps.games().filter((g) => g.executablePath || g.path);
      return (await this.platform.runningGames(games)).map((r) => r.gameId);
    } catch {
      return [];
    }
  }
  private snapshot(running: string[] = []): FpsStatus {
    const capturing = this.state === "capturing";
    const end = capturing ? this.now() : this.endedAt || this.startedAt;
    return {
      state: this.state,
      gameId: this.game?.id ?? null,
      gameName: this.game?.name ?? null,
      code: this.code,
      detail: this.detail,
      elapsedSeconds: this.startedAt
        ? Math.max(0, Math.round((end - this.startedAt) / 1000))
        : 0,
      fps: this.lastFps,
      avgFps: this.acc.avgFps,
      low1Fps: this.acc.low1Fps,
      frames: this.acc.frames,
      frameTimes: [...this.acc.recent],
      fpsHistory: [...this.acc.perSecond],
      usage: this.usage,
      boost: this.boost(),
      benchmarkSeconds: this.benchSeconds,
      saved: this.saved,
      running,
    };
  }
  private boost(): FpsSummary["boost"] {
    return this.boostSeen.size === 2
      ? "mixed"
      : this.boostSeen.has(true)
        ? "on"
        : "off";
  }
  private push() {
    this.deps.notify({ type: "fps", status: this.snapshot() });
  }
  private release() {
    this.platform.elevation.release("fps");
    if (this.benchTimer) clearTimeout(this.benchTimer);
    this.benchTimer = null;
  }
  /** Asks the helper to measure one running library game. Opens one Windows administrator prompt. */
  async start(gameId: string, benchmarkSeconds?: number): Promise<FpsStatus> {
    if (this.active) throw new Error("An FPS capture is already running.");
    if (!this.platform.spawnFps)
      throw new Error("FPS capture needs the Windows helper.");
    const game = this.deps.games().find((g) => g.id === gameId);
    if (!game) throw new Error("That game is not in the library.");
    const target = (await this.platform.runningGames([game]))[0]?.target;
    if (!target)
      throw new Error(`${game.name} is not running. Start the game first.`);
    // Another start may have won while runningGames was awaited; never open a second prompt.
    if (this.active) throw new Error("An FPS capture is already running.");
    // Throws NotApplied when another administrator prompt is open.
    this.platform.elevation.hold("fps");
    this.game = game;
    this.state = "starting";
    this.code = null;
    this.detail =
      "Asking Windows for administrator approval to measure frames.";
    this.acc = new FpsAccumulator();
    this.startedAt = 0;
    this.endedAt = 0;
    this.lastFps = null;
    this.usage = null;
    this.saved = null;
    this.benchSeconds = benchmarkSeconds ?? null;
    this.usageSum = { cpu: 0, gpu: 0, cpuN: 0, gpuN: 0 };
    this.boostSeen = new Set([this.deps.boostOn(game.id)]);
    let channel: SessionChannel;
    try {
      channel = this.platform.spawnFps();
    } catch (error) {
      this.release();
      this.state = "unavailable";
      this.code = "helper";
      this.detail = "The Windows helper could not start FPS capture.";
      this.push();
      throw error;
    }
    this.channel = channel;
    channel.on("event", (raw: unknown) => {
      if (this.channel === channel) this.onEvent(raw);
    });
    channel.on("exit", () => {
      if (this.channel !== channel) return;
      this.channel = null;
      if (this.active) {
        if (this.state === "starting")
          this.fail(
            "helper",
            "The Windows helper stopped before FPS capture started.",
          );
        else this.finish("The capture helper stopped.");
      }
    });
    channel.send({
      command: "start",
      gamePid: target.pid,
      gameStartTime: target.startTime,
      parentPid: process.pid,
    });
    this.push();
    return this.snapshot();
  }
  private onEvent(raw: unknown) {
    const parsed = FpsEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    switch (event.event) {
      case "approval":
        this.detail = "Waiting for Windows administrator approval.";
        break;
      case "ready":
        this.release();
        this.state = "capturing";
        this.startedAt = this.now();
        // A timed benchmark run ends itself; the countdown in the window is the same length.
        if (this.benchSeconds)
          this.benchTimer = setTimeout(
            () => void this.stop(),
            this.benchSeconds * 1000,
          );
        this.detail =
          "Measuring. Play the game; frames appear within a second.";
        break;
      case "frames": {
        if (this.state !== "capturing") return;
        const fps = this.acc.add(event.frameTimesMs);
        if (fps !== null) this.lastFps = fps;
        if (this.game) this.boostSeen.add(this.deps.boostOn(this.game.id));
        const seconds = (this.now() - this.startedAt) / 1000;
        if (this.acc.frames === 0 && seconds >= noFramesAfter) {
          this.code = "no-frames";
          this.detail =
            "No frames seen yet. Only DirectX 9/10/11/12 games are measured (Vulkan and OpenGL games are not), and a minimized or paused game or one protected by anti-cheat shows nothing.";
        } else if (this.code === "no-frames" && this.acc.frames > 0) {
          this.code = null;
          this.detail = "Measuring.";
        }
        break;
      }
      case "usage":
        this.usage = {
          cpuPercent: event.cpuPercent,
          workingSetBytes: event.workingSetBytes,
          gpuPercent: event.gpuPercent,
        };
        this.usageSum.cpu += event.cpuPercent;
        this.usageSum.cpuN++;
        if (event.gpuPercent !== null) {
          this.usageSum.gpu += event.gpuPercent;
          this.usageSum.gpuN++;
        }
        break;
      case "unavailable":
        this.fail(event.code, event.detail);
        return;
      case "ended":
        this.finish(
          event.reason === "game-exited"
            ? "The game closed."
            : event.reason === "stop"
              ? "Capture stopped."
              : "The capture ended.",
        );
        return;
    }
    this.push();
  }
  private fail(code: string, detail: string) {
    this.release();
    this.state = "unavailable";
    this.code = code;
    this.detail = detail.slice(0, 500);
    this.endChannel();
    this.push();
    this.wake();
  }
  private finish(why: string) {
    this.release();
    const wasCapturing = this.startedAt > 0;
    this.endedAt = this.now();
    this.state = "ended";
    this.code = null;
    const seconds = Math.round((this.endedAt - this.startedAt) / 1000);
    if (
      wasCapturing &&
      this.game &&
      seconds >= minSummarySeconds &&
      this.acc.frames >= minSummaryFrames
    ) {
      const summary: FpsSummary = {
        id: randomUUID(),
        gameId: this.game.id,
        gameName: this.game.name.slice(0, 80),
        at: new Date(this.startedAt).toISOString(),
        durationSeconds: seconds,
        frames: this.acc.frames,
        avgFps: round1(this.acc.avgFps ?? 0),
        low1Fps: this.acc.low1Fps === null ? null : round1(this.acc.low1Fps),
        boost: this.boost(),
        low01Fps: this.acc.low01Fps === null ? null : round1(this.acc.low01Fps),
        p99Ms:
          this.acc.p99Ms === null
            ? null
            : Math.round(this.acc.p99Ms * 100) / 100,
        stutters: this.acc.stutters,
        cpuPercent: this.usageSum.cpuN
          ? round1(this.usageSum.cpu / this.usageSum.cpuN)
          : null,
        gpuPercent: this.usageSum.gpuN
          ? round1(this.usageSum.gpu / this.usageSum.gpuN)
          : null,
        benchmarkSeconds: this.benchSeconds,
      };
      this.save(summary);
      if (this.benchSeconds)
        this.deps.setMeta(
          runsKey(summary.gameId),
          [summary, ...this.runs(summary.gameId)].slice(0, keepRuns),
        );
      this.saved = summary;
      this.detail = `${why} Saved: ${summary.avgFps} FPS average over ${seconds} s.`;
    } else {
      this.detail = `${why} Too short to save (needs ${minSummarySeconds} s and ${minSummaryFrames} frames).`;
    }
    this.endChannel();
    this.push();
    this.wake();
  }
  private save(summary: FpsSummary) {
    const key = summaryKey(summary.gameId);
    const old = this.history(summary.gameId);
    this.deps.setMeta(key, [summary, ...old].slice(0, keepPerGame));
    const low =
      summary.low1Fps === null ? "" : `, 1% low ${summary.low1Fps} FPS`;
    this.deps.log(
      "FPS capture saved",
      `${summary.gameName}: ${summary.avgFps} FPS average${low}, ${formatDuration(summary.durationSeconds)}, Game Mode ${summary.boost}. Measured on this PC; results vary with the scene.`.slice(
        0,
        1000,
      ),
    );
  }
  /** Saved summaries for one game, newest first. */
  history(gameId: string): FpsSummary[] {
    const raw = this.deps.meta(summaryKey(gameId));
    const parsed = FpsSummarySchema.array().safeParse(raw);
    return parsed.success ? parsed.data : [];
  }
  /** Timed benchmark runs of the current, unsaved set, newest first. */
  runs(gameId: string): FpsSummary[] {
    const parsed = FpsSummarySchema.array().safeParse(
      this.deps.meta(runsKey(gameId)),
    );
    return parsed.success ? parsed.data : [];
  }
  reports(gameId: string): BenchReport[] {
    const parsed = BenchReportSchema.array().safeParse(
      this.deps.meta(reportsKey(gameId)),
    );
    return parsed.success ? parsed.data : [];
  }
  benchData(gameId: string) {
    return { runs: this.runs(gameId), reports: this.reports(gameId) };
  }
  /** Snapshots the current runs as a report and starts a new set. Results are recomputed from the runs whenever they are shown. */
  benchSave(gameId: string) {
    const runs = this.runs(gameId);
    if (!runs.length) throw new Error("There are no benchmark runs to save.");
    const game = this.deps.games().find((g) => g.id === gameId);
    const report: BenchReport = {
      id: randomUUID(),
      gameId,
      gameName: (game?.name ?? runs[0]!.gameName).slice(0, 80),
      at: new Date().toISOString(),
      runs: [...runs].reverse(),
    };
    this.deps.setMeta(
      reportsKey(gameId),
      [report, ...this.reports(gameId)].slice(0, keepReports),
    );
    this.deps.setMeta(runsKey(gameId), []);
    this.deps.log(
      "Benchmark report saved",
      `${report.gameName}: ${runs.length} timed run(s). Open the Monitor page to read or export it.`,
    );
    return this.benchData(gameId);
  }
  benchDiscard(gameId: string) {
    this.deps.setMeta(runsKey(gameId), []);
    return this.benchData(gameId);
  }
  findReport(reportId: string): BenchReport | null {
    for (const g of this.deps.games()) {
      const found = this.reports(g.id).find((r) => r.id === reportId);
      if (found) return found;
    }
    return null;
  }
  private endChannel() {
    const channel = this.channel;
    this.channel = null;
    channel?.kill();
  }
  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }
  /** Stops the capture and resolves with the final status (saved summary included). The helper answers within about six seconds. */
  async stop(): Promise<FpsStatus> {
    if (!this.active || !this.channel) return this.status();
    const settled = new Promise<void>((resolve) => this.waiters.push(resolve));
    this.channel.send({ command: "stop" });
    const timer = setTimeout(() => {
      if (!this.active) return;
      if (this.state === "starting")
        this.fail("cancelled", "FPS capture was cancelled.");
      else this.finish("Capture stopped.");
    }, 10000);
    await settled;
    clearTimeout(timer);
    return this.status();
  }
  /** App quit: end the helper without waiting; the elevated child leaves when its parent does. */
  dispose() {
    if (this.active) this.release();
    this.endChannel();
    this.state = "idle";
  }
}
const round1 = (n: number) => Math.round(n * 10) / 10;
function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  return m ? `${m} min ${seconds % 60} s` : `${seconds} s`;
}
