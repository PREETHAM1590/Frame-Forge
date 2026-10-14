import {
  MonitorSampleSchema,
  type AppEvent,
  type MonitorSample,
} from "../shared/contracts.js";
import type { Platform, SessionChannel } from "./platform.js";
/**
 * Live system counters. The helper process exists only while the Monitor page asks for it: stop() ends it completely,
 * so a hidden page costs nothing (no timer, no helper, no polling).
 */
export class MonitorService {
  private channel: SessionChannel | null = null;
  /** The page asked for readings (monitorStart without a later monitorStop). */
  private wanted = false;
  /** The latest valid sample, for tests and for a page that reopens within the same process. */
  last: MonitorSample | null = null;
  constructor(
    private platform: Platform,
    private notify: (event: AppEvent) => void,
  ) {}
  get active() {
    return this.channel !== null;
  }
  start(): boolean {
    if (!this.platform.spawnMonitor)
      throw new Error("The live monitor needs the Windows helper.");
    this.wanted = true;
    return this.spawn();
  }
  private spawn(): boolean {
    if (this.channel) return true;
    const channel = this.platform.spawnMonitor!();
    this.channel = channel;
    channel.on("event", (raw: unknown) => {
      if (this.channel !== channel || !raw || typeof raw !== "object") return;
      const { event, ...fields } = raw as Record<string, unknown>;
      if (event !== "sample") return;
      const parsed = MonitorSampleSchema.safeParse(fields);
      if (!parsed.success) return;
      this.last = parsed.data;
      this.notify({ type: "monitor", sample: parsed.data });
    });
    channel.on("exit", () => {
      if (this.channel === channel) this.channel = null;
    });
    return true;
  }
  stop(): boolean {
    this.wanted = false;
    return this.end();
  }
  private end(): boolean {
    const channel = this.channel;
    this.channel = null;
    this.last = null;
    if (!channel) return false;
    channel.send({ command: "stop" });
    channel.kill();
    return true;
  }
  /** The window was minimized or hidden: end the helper, but remember that the page still wants readings. */
  suspend() {
    this.end();
  }
  /** The window is back: start again if the page still wants readings. */
  resume() {
    if (this.wanted) this.spawn();
  }
}
