// Smart mode, the engine part: watches a game for its first minute, classifies the bottleneck (shared/smart.ts), keeps a
// learned profile per game and offers to add games that are not in the library. It only observes; BoostEngine applies the plan.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  MonitorSampleSchema,
  SmartProfileSchema,
  type BoosterConfig,
  type CustomMechanisms,
  type ForegroundApp,
  type Game,
  type MonitorSample,
  type ProcessTarget,
  type SmartProfile,
  type SmartStatus,
  type SmartVerdict,
  type AppEvent,
} from "../shared/contracts.js";
import { effectiveBackground } from "../shared/background.js";
import {
  chosenNames,
  classify,
  fingerprintOf,
  growth,
  kindLabel,
  parseSmi,
  plan,
  setBottleneckSource,
  verdictOf,
  type FpsHint,
  type SmartSample,
} from "../shared/smart.js";
import type { Repository } from "./repository.js";
import type { Platform, SessionChannel } from "./platform.js";

export const observeSeconds = 60;
const profilesKey = "smart:profiles";
const dismissedKey = "smart:dismissed";

/** What BoostEngine runs for a Smart session. */
export interface SmartDecision {
  mechanisms: CustomMechanisms;
  background: BoosterConfig["background"];
  verdict: SmartVerdict;
}
type Smi = ReturnType<typeof parseSmi>;
export interface SmartHooks {
  notify: (event: AppEvent) => void;
  log: (label: string, message: string, status?: "success" | "failed") => void;
  /** Frame statistics of a running FPS capture, when there is one. */
  fps?: () => FpsHint | null;
  /** nvidia-smi clock, temperature and limits; null when unavailable. */
  readSmi?: () => Promise<Smi>;
  now?: () => number;
  seconds?: number;
}

const smiPath = () =>
  [
    path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "NVIDIA Corporation",
      "NVSMI",
      "nvidia-smi.exe",
    ),
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "nvidia-smi.exe"),
  ].find((p) => existsSync(p));
function runSmi(exe: string, field: string): Promise<Smi> {
  return new Promise((resolve) => {
    execFile(
      exe,
      [`--query-gpu=clocks.gr,clocks.max.gr,temperature.gpu,${field}`, "--format=csv,noheader,nounits"],
      { timeout: 4000, windowsHide: true },
      (error, stdout) => resolve(error ? null : parseSmi(stdout)),
    );
  });
}
export async function readNvidiaSmi(): Promise<Smi> {
  const exe = smiPath();
  if (!exe) return null;
  return (
    (await runSmi(exe, "clocks_throttle_reasons.active")) ??
    (await runSmi(exe, "clocks_event_reasons.active"))
  );
}

/** One monitor reading as the classifier wants it. `smi` is the latest GPU read (it updates every few seconds). */
export function toSmartSample(
  ms: MonitorSample,
  gameImage: string,
  smi: Smi,
): SmartSample {
  const cores = ms.cpu.cores;
  const adapters = [...ms.gpu.adapters].sort((a, b) => b.engine3d - a.engine3d);
  const busy = adapters[0];
  const biggest = Math.max(0, ...ms.gpu.adapters.map((a) => a.dedicatedBytes));
  const name = gameImage.replace(/\.exe$/i, "").toLowerCase();
  const isGame = (n: string) => n.toLowerCase() === name;
  const others = ms.processes.byCpu.filter(
    (p) => !isGame(p.name) && !/^(frameforge|system idle)/i.test(p.name),
  );
  const game = [...ms.processes.byMemory, ...ms.processes.byCpu].find((p) =>
    isGame(p.name),
  );
  return {
    cpuTotal: ms.cpu.total,
    maxCore: cores.length ? Math.max(...cores) : ms.cpu.total,
    saturatedCores: cores.filter((c) => c >= 90).length,
    gpu3d: busy?.engine3d ?? 0,
    // The integrated GPU shares system memory: little dedicated memory next to a real dedicated card.
    busyAdapterIntegrated:
      !!busy && busy.dedicatedBytes < 1.5 * 1024 ** 3 && biggest >= 2 * 1024 ** 3,
    memUsedPercent:
      ms.memory.totalBytes > 0
        ? (1 - ms.memory.availableBytes / ms.memory.totalBytes) * 100
        : 0,
    availableBytes: ms.memory.availableBytes,
    gameWorkingSetBytes: game?.workingSetBytes ?? null,
    backgroundCpu: others.reduce((s, p) => s + p.cpuPercent, 0),
    gpuClockPercent: smi?.clockPercent ?? null,
    gpuThrottled: smi?.throttled ?? [],
    gpuTempC: smi?.tempC ?? null,
    cpuPerformance: ms.cpu.performance ?? null,
  };
}

export interface Observation {
  game: Game;
  target: ProcessTarget;
  startedAt: number;
  samples: SmartSample[];
  channel: SessionChannel | null;
  timers: NodeJS.Timeout[];
  done: (decision: SmartDecision | null) => void;
  fingerprint: string;
  smi: Smi;
  laptop: boolean;
}

export class SmartEngine {
  private obs: Observation | null = null;
  private fp: { at: number; value: string; laptop: boolean } | null = null;
  candidate: { name: string; path: string } | null = null;
  constructor(
    private repo: Repository,
    private platform: Platform,
    private hooks: SmartHooks,
  ) {
    setBottleneckSource((gameId) => this.profile(gameId)?.classification ?? null);
  }
  private now() {
    return (this.hooks.now ?? Date.now)();
  }
  get observing() {
    return this.obs !== null;
  }
  isObserving(gameId: string) {
    return this.obs?.game.id === gameId;
  }

  // ---- profiles (one meta record, validated on read) ----
  private all(): Record<string, SmartProfile> {
    const raw = this.repo.meta(profilesKey);
    const result: Record<string, SmartProfile> = {};
    if (raw && typeof raw === "object")
      for (const [id, value] of Object.entries(raw)) {
        const parsed = SmartProfileSchema.safeParse(value);
        if (parsed.success) result[id] = parsed.data;
      }
    return result;
  }
  profiles(): SmartProfile[] {
    return Object.values(this.all());
  }
  profile(gameId: string): SmartProfile | null {
    return this.all()[gameId] ?? null;
  }
  private save(profile: SmartProfile) {
    this.repo.setMeta(profilesKey, { ...this.all(), [profile.gameId]: profile });
  }
  forget(gameId: string) {
    const all = this.all();
    delete all[gameId];
    this.repo.setMeta(profilesKey, all);
  }
  /** A session ran with this profile: count it. */
  used(gameId: string) {
    const p = this.profile(gameId);
    if (p) this.save({ ...p, sessions: p.sessions + 1 });
  }
  status(): SmartStatus {
    const o = this.obs;
    return {
      observing: o
        ? {
            gameId: o.game.id,
            gameName: o.game.name.slice(0, 80),
            elapsedSeconds: Math.min(
              this.seconds,
              Math.max(o.samples.length, Math.floor((this.now() - o.startedAt) / 1000)),
            ),
            totalSeconds: this.seconds,
          }
        : null,
      profiles: this.profiles(),
      candidate: this.candidate,
    };
  }
  private get seconds() {
    return this.hooks.seconds ?? observeSeconds;
  }
  private emit() {
    this.hooks.notify({ type: "smart", status: this.status() });
  }

  /** The hardware as one string; a changed driver, GPU or memory layout makes a saved profile stale. */
  async fingerprint(): Promise<{ value: string; laptop: boolean }> {
    if (this.fp && this.now() - this.fp.at < 600000) return this.fp;
    let value = "unknown hardware";
    let laptop = false;
    try {
      const facts = await this.platform.healthFacts?.([]);
      if (facts) {
        value = fingerprintOf({
          cpu: facts.cpuName,
          gpus: facts.gpus.map((g) => ({ name: g.name, driver: g.driverVersion })),
          ramBytes: facts.memory.totalBytes,
          sticks: facts.memory.sticks.length,
          ramMTs: facts.memory.sticks[0]?.configuredMTs ?? null,
        });
        laptop = facts.battery.present;
      }
    } catch {
      /* A failed read keeps the generic fingerprint; the profile then never goes stale on hardware. */
    }
    this.fp = { at: this.now(), value, laptop };
    return this.fp;
  }

  private async background(game: Game, config: BoosterConfig) {
    let processes: Awaited<ReturnType<Platform["backgroundProcesses"]>> = [];
    try {
      processes = await this.platform.backgroundProcesses();
    } catch {
      /* Without a process list the suggested set is empty; saved lists still apply. */
    }
    const image = game.executablePath ? path.win32.basename(game.executablePath) : undefined;
    return effectiveBackground(game, config, processes, {
      gameImage: image,
      gameSource: game.source,
    });
  }

  private decisionFrom(
    p: SmartProfile,
    background: BoosterConfig["background"],
  ): SmartDecision {
    return {
      mechanisms: p.mechanisms,
      background,
      verdict: {
        classification: p.classification,
        flags: p.flags,
        reasons: [
          `Using what Smart mode learned for this game on this PC (${kindLabel[p.classification]}, ${p.at.slice(0, 10)}).`,
          ...p.reasons,
        ].slice(0, 12),
        advice: p.advice,
        nextAction: p.nextAction,
        chosen: [],
        profileUsed: true,
      },
    };
  }

  /**
   * A Smart-mode game started. With a profile that still fits this hardware the answer is immediate; otherwise the game is
   * watched for about a minute and `done` is called with the decision (or null if the game ended / it was cancelled).
   */
  async prepare(
    game: Game,
    target: ProcessTarget,
    config: BoosterConfig,
    done: (decision: SmartDecision | null) => void,
  ): Promise<SmartDecision | "observing"> {
    const fp = await this.fingerprint();
    const saved = this.profile(game.id);
    const background = (await this.background(game, config)).rules;
    if (saved && saved.fingerprint === fp.value) {
      const decision = this.decisionFrom(saved, background);
      decision.verdict.chosen = chosenNames(saved.mechanisms);
      return decision;
    }
    if (this.obs) {
      // One observation at a time; a second game waits for the next launch.
      done(null);
      return "observing";
    }
    this.begin(game, target, fp, config, done);
    return "observing";
  }

  private begin(
    game: Game,
    target: ProcessTarget,
    fp: { value: string; laptop: boolean },
    config: BoosterConfig,
    done: (decision: SmartDecision | null) => void,
  ) {
    const obs: Observation = {
      game,
      target,
      startedAt: this.now(),
      samples: [],
      channel: null,
      timers: [],
      fingerprint: fp.value,
      laptop: fp.laptop,
      smi: null,
      done,
    };
    this.obs = obs;
    this.hooks.log("Smart mode", `Watching ${game.name} for ${this.seconds} seconds to find what limits it. Nothing is changed during this time.`);
    this.emit();
    const image = path.win32.basename(game.executablePath ?? target.executablePath);
    const channel = this.platform.spawnMonitor?.() ?? null;
    obs.channel = channel;
    const readSmi = this.hooks.readSmi ?? readNvidiaSmi;
    const poll = async () => {
      try {
        obs.smi = await readSmi();
      } catch {
        obs.smi = null;
      }
    };
    void poll();
    obs.timers.push(setInterval(() => void poll(), 5000));
    // The channel is the only source of samples; if it never delivers, finish with what exists.
    obs.timers.push(setTimeout(() => void this.finish(obs, config), (this.seconds + 30) * 1000));
    for (const t of obs.timers) t.unref?.();
    if (!channel) {
      void this.finish(obs, config);
      return;
    }
    channel.on("event", (raw: unknown) => {
      if (this.obs !== obs || !raw || typeof raw !== "object") return;
      const { event, ...fields } = raw as Record<string, unknown>;
      if (event !== "sample") return;
      const parsed = MonitorSampleSchema.safeParse(fields);
      if (!parsed.success) return;
      this.feed(obs, parsed.data, image, config);
    });
    channel.on("exit", () => {
      if (this.obs === obs && obs.samples.length < this.seconds) void this.finish(obs, config);
    });
  }

  /** One monitor reading arrives. Exported through the class so tests can drive it without a helper. */
  feed(obs: Observation, ms: MonitorSample, image: string, config: BoosterConfig) {
    obs.samples.push(toSmartSample(ms, image, obs.smi));
    // The game is the thing being measured: stop when it is gone.
    if (obs.samples.length % 5 === 0 && !this.alive(obs.target)) {
      this.cancel("The game closed before Smart mode finished watching it.");
      return;
    }
    if (obs.samples.length % 10 === 0) this.emit();
    if (obs.samples.length >= this.seconds) void this.finish(obs, config);
  }
  /** For tests: the running observation. */
  get current() {
    return this.obs;
  }
  private alive(target: ProcessTarget) {
    try {
      process.kill(target.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  cancel(reason = "Smart mode stopped watching.") {
    const obs = this.obs;
    if (!obs) return false;
    this.clear(obs);
    this.hooks.log("Smart mode", reason);
    obs.done(null);
    this.emit();
    return true;
  }
  private clear(obs: Observation) {
    // First, so the channel's exit handler (fired by kill) sees a finished observation.
    if (this.obs === obs) this.obs = null;
    for (const t of obs.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    obs.timers = [];
    try {
      obs.channel?.send({ command: "stop" });
      obs.channel?.kill();
    } catch {
      /* The helper is already gone. */
    }
  }

  private async finish(obs: Observation, config: BoosterConfig) {
    if (this.obs !== obs) return;
    this.clear(obs);
    const fps = this.hooks.fps?.() ?? null;
    const c = classify(obs.samples, fps);
    const g = growth(obs.samples);
    const p = plan(c, {
      gameWorkingSetGrowing: g !== null && g > 512 * 1024,
      laptop: obs.laptop,
      samples: obs.samples.length,
    });
    if (fps)
      c.reasons.push(
        `FPS while watching (before any change): about ${Math.round(fps.avg)} average${fps.low1 ? `, ${Math.round(fps.low1)} for the slowest 1%` : ""}.`,
      );
    const background = (await this.background(obs.game, config)).rules;
    const verdict = verdictOf(c, p, false);
    const profile: SmartProfile = {
      gameId: obs.game.id,
      gameName: obs.game.name.slice(0, 80),
      fingerprint: obs.fingerprint,
      classification: c.kind,
      flags: c.flags,
      mechanisms: p.mechanisms,
      background,
      reasons: verdict.reasons,
      advice: p.advice.slice(0, 8),
      nextAction: p.nextAction,
      at: new Date(this.now()).toISOString(),
      sessions: 0,
    };
    // Too little data to trust is not saved, so the next launch watches again.
    if (c.enough) this.save(profile);
    this.hooks.log(
      "Smart mode",
      `${obs.game.name}: ${kindLabel[c.kind]}. ${p.why.join(" ")} ${c.enough ? "Saved for next time." : "Not saved: too little data."}`,
    );
    this.emit();
    obs.done({ mechanisms: p.mechanisms, background, verdict });
  }

  // ---- games that are not in the library ----
  dismissed(): string[] {
    const raw = this.repo.meta(dismissedKey);
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  }
  /** A game-like program was found. The person decides; nothing is added or boosted by itself. */
  offer(app: { name: string; path: string }) {
    if (this.dismissed().includes(app.path.toLowerCase())) return false;
    this.candidate = { name: app.name.slice(0, 80), path: app.path.slice(0, 2048) };
    this.emit();
    return true;
  }
  dismiss() {
    if (this.candidate)
      this.repo.setMeta(dismissedKey, [
        ...this.dismissed().slice(-199),
        this.candidate.path.toLowerCase(),
      ]);
    this.candidate = null;
    this.emit();
  }
  take(): { name: string; path: string } | null {
    const c = this.candidate;
    this.candidate = null;
    this.emit();
    return c;
  }
}

// ---- finding a game that is not in the library: pure heuristics, fed by a poller ----
const notGames =
  /^(chrome|msedge|firefox|brave|opera|vivaldi|iexplore|vlc|mpv|mpc-hc\w*|potplayer\w*|wmplayer|spotify|netflix|obs\d*|davinci\w*|resolve|blender|premiere\w*|afterfx|photoshop|code|devenv|powerpnt|winword|excel|teams|ms-teams|zoom|discord|steam|steamwebhelper|epicgameslauncher|battle\.net|riotclientservices|riotclientux|galaxyclient|xboxpcapp|remotedesktop|mstsc|vmware\w*|vmplayer|virtualbox\w*|parsecd|moonlight|steamlink|rustdesk)$/i;
export const looksLikeNotAGame = (image: string) =>
  notGames.test(image.replace(/\.exe$/i, ""));
export const prettyName = (image: string) =>
  image
    .replace(/\.exe$/i, "")
    .replace(/[-_](win(32|64)|shipping|launcher|client)\b.*$/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .slice(0, 80) || image;

export interface TrackerOptions {
  seconds?: number;
  gpuMin?: number;
}
/**
 * A candidate is a foreground fullscreen or borderless program that is not in the library, not on the ignore list and not
 * dismissed, using the GPU's 3D engine heavily, continuously, for at least `seconds` (default 30).
 */
export class CandidateTracker {
  private pid = 0;
  private since = 0;
  private offered = new Set<number>();
  constructor(
    private inLibrary: (exePath: string) => boolean,
    private dismissed: (exePath: string) => boolean,
    private opts: TrackerOptions = {},
  ) {}
  eligible(app: ForegroundApp | null): app is ForegroundApp {
    return (
      !!app &&
      app.fullscreen &&
      !looksLikeNotAGame(app.image) &&
      !this.inLibrary(app.path) &&
      !this.dismissed(app.path)
    );
  }
  feed(
    app: ForegroundApp | null,
    gpu3d: number | null,
    nowMs: number,
  ): { name: string; path: string } | null {
    const heavy = this.eligible(app) && (gpu3d ?? 0) >= (this.opts.gpuMin ?? 50);
    if (!heavy || !app) {
      this.pid = 0;
      return null;
    }
    if (app.pid !== this.pid) {
      this.pid = app.pid;
      this.since = nowMs;
      return null;
    }
    if (
      nowMs - this.since >= (this.opts.seconds ?? 30) * 1000 &&
      !this.offered.has(app.pid)
    ) {
      this.offered.add(app.pid);
      if (this.offered.size > 100) this.offered.clear();
      return { name: prettyName(app.image), path: app.path };
    }
    return null;
  }
}

/** Polls the foreground program (cheap, every 15 s) and, only while a candidate is in front, reads GPU load. */
export class GameFinder {
  private timer: NodeJS.Timeout | undefined;
  private channel: SessionChannel | null = null;
  private last: ForegroundApp | null = null;
  private busy = false;
  constructor(
    private platform: Platform,
    private tracker: CandidateTracker,
    private found: (app: { name: string; path: string }) => void,
    private intervalMs = 15000,
  ) {}
  get running() {
    return this.timer !== undefined;
  }
  start() {
    if (this.timer || !this.platform.foregroundApp) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closeChannel();
    this.last = null;
  }
  private closeChannel() {
    try {
      this.channel?.send({ command: "stop" });
      this.channel?.kill();
    } catch {
      /* Already gone. */
    }
    this.channel = null;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.last = (await this.platform.foregroundApp?.()) ?? null;
      if (this.tracker.eligible(this.last)) {
        if (!this.channel && this.platform.spawnMonitor) {
          const channel = this.platform.spawnMonitor();
          this.channel = channel;
          channel.on("event", (raw: unknown) => {
            const { event, ...fields } = (raw ?? {}) as Record<string, unknown>;
            if (event !== "sample") return;
            const parsed = MonitorSampleSchema.safeParse(fields);
            if (!parsed.success) return;
            const gpu = Math.max(0, ...parsed.data.gpu.adapters.map((a) => a.engine3d));
            const hit = this.tracker.feed(this.last, gpu, Date.now());
            if (hit) this.found(hit);
          });
          channel.on("exit", () => {
            if (this.channel === channel) this.channel = null;
          });
        }
      } else {
        this.tracker.feed(null, null, Date.now());
        this.closeChannel();
      }
    } catch {
      this.closeChannel();
    } finally {
      this.busy = false;
    }
  }
}
