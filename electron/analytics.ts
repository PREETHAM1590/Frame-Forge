import { OperationId, featurePages } from "../shared/contracts.js";
import { presets } from "../shared/catalogue.js";

export interface AnalyticsSdk {
  trackEvent(
    name: string,
    props?: Record<string, string | number | boolean>,
  ): Promise<void>;
}

const version = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const modes = new Set(["balanced", "performance", "competitive", "custom"]);
const presetNames = new Set<string>(presets.map((p) => p.name));
const pages = new Set<string>(featurePages);
// Exactly these events and property values leave the app; anything else is dropped.
const allowed: Record<string, (p: Record<string, string>) => boolean> = {
  app_started: (p) =>
    version.test(p.version ?? "") && /^\d{1,6}$/.test(p.os_build ?? ""),
  mode_started: (p) => modes.has(p.mode ?? ""),
  optimization_applied: (p) => OperationId.safeParse(p.id).success,
  preset_applied: (p) => presetNames.has(p.id ?? ""),
  update_installed: (p) => version.test(p.version ?? ""),
  feature_opened: (p) => pages.has(p.page ?? ""),
};
const keys: Record<string, string[]> = {
  app_started: ["os_build", "version"],
  mode_started: ["mode"],
  optimization_applied: ["id"],
  preset_applied: ["id"],
  update_installed: ["version"],
  feature_opened: ["page"],
};

/** US and EU Aptabase keys only; the SDK derives the host from the key's region part. */
export const validAppKey = (key: string | undefined): key is string =>
  !!key && /^A-(US|EU)-\d{6,12}$/.test(key);

export class Analytics {
  constructor(
    private sdk: AnalyticsSdk | null,
    /** Read on every event, so turning the setting off stops sending immediately. */
    private optedIn: () => boolean,
  ) {}
  get available() {
    return this.sdk !== null;
  }
  track(event: string, props: Record<string, string> = {}) {
    if (!this.sdk || !this.optedIn()) return false;
    const k = Object.keys(props).sort().join();
    if (!allowed[event] || k !== keys[event]!.join() || !allowed[event](props))
      return false;
    this.sdk.trackEvent(event, props).catch(() => {});
    return true;
  }
}
