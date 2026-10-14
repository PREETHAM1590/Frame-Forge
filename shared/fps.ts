// Frame statistics from frame times (milliseconds). Shared by the main process (session summaries) and the Monitor page (live numbers).
//
// "1% low" here is the average FPS of the slowest 1% of frames: a frame-time histogram (0.1 ms bins) keeps the cost constant however long the session runs,
// and each bin keeps the exact sum of its frame times so the averages are not rounded to the bin width.
const binMs = 0.1;
const binCount = 10001; // 0 to 1000 ms; slower frames land in the last bin
/** Fewer frames than this and "1% of frames" is a single frame, which says nothing. */
export const minFramesForLow = 100;

export class FpsAccumulator {
  private counts = new Uint32Array(binCount);
  private sums = new Float64Array(binCount);
  frames = 0;
  totalMs = 0;
  /** The latest frame times, for the frame-time graph. */
  recent: number[] = [];
  /** Average FPS of each reported second, for the FPS line. */
  perSecond: number[] = [];
  constructor(
    private recentMax = 240,
    private secondsMax = 120,
  ) {}
  /** Adds one batch (normally one second) of frame times and returns that batch's FPS, or null for an empty batch. */
  add(frameTimes: readonly number[]): number | null {
    let batchMs = 0;
    let batchFrames = 0;
    for (const ms of frameTimes) {
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const bin = Math.min(binCount - 1, Math.floor(ms / binMs));
      this.counts[bin]++;
      this.sums[bin] += ms;
      batchMs += ms;
      batchFrames++;
      this.recent.push(ms);
    }
    if (this.recent.length > this.recentMax)
      this.recent.splice(0, this.recent.length - this.recentMax);
    this.frames += batchFrames;
    this.totalMs += batchMs;
    const fps = batchFrames ? (batchFrames * 1000) / batchMs : null;
    this.perSecond.push(fps ?? 0);
    if (this.perSecond.length > this.secondsMax)
      this.perSecond.splice(0, this.perSecond.length - this.secondsMax);
    return fps;
  }
  get avgFps(): number | null {
    return this.frames ? (this.frames * 1000) / this.totalMs : null;
  }
  get low1Fps(): number | null {
    if (this.frames < minFramesForLow) return null;
    let want = Math.ceil(this.frames * 0.01);
    const taken = want;
    let sum = 0;
    for (let bin = binCount - 1; bin >= 0 && want > 0; bin--) {
      const count = this.counts[bin];
      if (!count) continue;
      const use = Math.min(count, want);
      // The bin's frames are interchangeable at this resolution; take their average for the part used.
      sum += (this.sums[bin] * use) / count;
      want -= use;
    }
    return (taken * 1000) / sum;
  }
}

/** One-shot version for tests and callers that hold a whole array. */
export function frameStats(frameTimes: readonly number[]) {
  const acc = new FpsAccumulator(0, 0);
  acc.add(frameTimes);
  return { frames: acc.frames, avgFps: acc.avgFps, low1Fps: acc.low1Fps };
}
