import {
  type BoostMode,
  type BoosterConfig,
  type CustomMechanisms,
  type MechanismId,
  type MechanismResult,
  type Response,
  type TimerStatus,
} from "../../../shared/contracts";
export const modes: { id: BoostMode; label: string; summary: string }[] = [
  { id: "off", label: "Off", summary: "Frameforge changes nothing." },
  {
    id: "balanced",
    label: "Balanced",
    summary:
      "Windows Game Mode, Above normal game priority, Game Bar capture off for the session and a power-throttling opt-out for the game.",
  },
  {
    id: "performance",
    label: "Performance",
    summary:
      "Adds High priority, a performance power plan, lowering selected background apps and, on Windows 10 hybrid CPUs, steering the game to the performance cores. On Windows 11 the CPU scheduler already does that, so it stays off.",
  },
  {
    id: "competitive",
    label: "Competitive",
    summary:
      "Adds suspending selected background apps, a finer timer where Windows supports it, plugged-in core unparking (on hybrid CPUs including the performance-core setting) and pausing a short list of safe Windows services (Windows asks for administrator approval at the start and at the end).",
  },
  {
    id: "custom",
    label: "Custom",
    summary: "Choose each mechanism yourself.",
  },
];
export const labels: Record<MechanismId, string> = {
  gameMode: "Windows Game Mode",
  priority: "Game priority",
  affinity: "Game CPU affinity",
  powerPlan: "Performance power plan",
  lowerBackground: "Lower background apps",
  suspendBackground: "Suspend background apps",
  closeBackground: "Close background apps",
  timerResolution: "High timer resolution",
  standbyPurge: "Standby list purge",
  pauseServices: "Pause Windows services",
  gameBarCapture: "Game Bar capture off",
  smartCores: "Smart core targeting",
  coreParking: "Disable core parking",
  powerThrottling: "Power throttling opt-out",
  gpuPriority: "GPU priority",
};
export const launchLabels = {
  gpuPreference: "High-performance GPU preference",
  fullscreenOptimizations: "Fullscreen optimizations off (advanced)",
} as const;
// Mechanisms whose "can't do it here" state is a property of this PC or Windows build, not a missing prerequisite.
export const unsupportedWhenUnavailable = new Set<MechanismId>([
  "timerResolution",
  "smartCores",
  "coreParking",
  "powerThrottling",
]);
export const tones: Record<
  MechanismResult["state"],
  "lime" | "amber" | "red" | "neutral" | "cyan"
> = {
  applied: "lime",
  reverted: "cyan",
  skipped: "neutral",
  unsupported: "amber",
  unavailable: "amber",
  conflict: "amber",
  failed: "red",
  pending: "amber",
};
// What a session result is called on screen: the state, unless a reason makes it clearer.
export function stateText(m: MechanismResult) {
  if (m.state === "pending") return "waiting for admin approval";
  if (m.state === "skipped" && m.code === "policy")
    return "already off by policy";
  if (m.state === "skipped" && m.code === "admin-not-requested")
    return "skipped — admin not requested";
  if (m.state === "skipped" && m.code === "managed")
    return "managed by an optimization";
  return m.state;
}
export const statusTones = {
  preparing: "amber",
  active: "lime",
  restoring: "amber",
  "recovery-needed": "red",
  ended: "neutral",
} as const;
export type Entry = { id: MechanismId; note?: string };
export function enabled(m: CustomMechanisms): Entry[] {
  const list: (Entry | false)[] = [
    m.gameMode && { id: "gameMode" },
    m.priority !== "Normal" && {
      id: "priority",
      note: m.priority === "High" ? "High" : "Above normal",
    },
    !!m.affinity?.length && {
      id: "affinity",
      note: `${m.affinity.length} CPUs`,
    },
    m.powerPlan && { id: "powerPlan" },
    m.lowerBackground && { id: "lowerBackground" },
    m.suspendBackground && { id: "suspendBackground" },
    m.closeBackground && { id: "closeBackground", note: "not reopened" },
    m.timerResolution && { id: "timerResolution" },
    m.powerThrottling && { id: "powerThrottling" },
    m.gameBarCapture && { id: "gameBarCapture" },
    m.smartCores && { id: "smartCores" },
    m.coreParking && { id: "coreParking" },
    m.gpuPriority && { id: "gpuPriority" },
    m.pauseServices && { id: "pauseServices", note: "administrator prompt" },
    m.standbyPurge && { id: "standbyPurge", note: "administrator prompt" },
  ];
  return list.filter((x): x is Entry => !!x);
}
export type Capability =
  Response<"boostStatus">["capabilities"]["mechanisms"][number];
export type Background = BoosterConfig["background"];
export const actionOf: Partial<
  Record<MechanismId, Background[number]["action"]>
> = {
  lowerBackground: "lower",
  suspendBackground: "suspend",
  closeBackground: "close",
};
// What a mechanism will really do on this PC, so modes show their actual difference.
export function onThisPc(
  { id, note }: Entry,
  cap: Capability | undefined,
  background: Background,
  // preset: a preset mode card; threadDirector: a hybrid CPU on Windows 11.
  ctx: {
    preset: boolean;
    threadDirector: boolean;
    timer?: TimerStatus;
  } = {
    preset: false,
    threadDirector: false,
  },
): { tone: "lime" | "amber" | "neutral"; label: string; reason: string } {
  const action = actionOf[id];
  if (action) {
    const apps = background.filter((b) => b.action === action);
    return apps.length
      ? {
          tone: "lime",
          label: "applies",
          reason: apps.map((b) => b.image).join(", "),
        }
      : {
          tone: "amber",
          label: "not configured",
          reason: "No apps picked yet. Add them under Background apps.",
        };
  }
  if (!cap) return { tone: "neutral", label: "checking", reason: "" };
  if (!cap.available) {
    // Windows 11 can allow a high timer resolution to reach games, and the app can turn that on for you.
    if (id === "timerResolution" && ctx.timer?.eligible)
      return {
        tone: "amber",
        label: ctx.timer.restartRequired
          ? "restart needed"
          : "needs a Windows setting",
        reason: cap.detail,
      };
    return {
      tone: "amber",
      label: unsupportedWhenUnavailable.has(id) ? "unsupported" : "unavailable",
      reason: cap.detail,
    };
  }
  if (id === "smartCores" && ctx.preset && ctx.threadDirector)
    return {
      tone: "neutral",
      label: "off by default here",
      reason:
        "Windows 11's Thread Director already places games on the performance cores. Turn it on under Custom to force it.",
    };
  if (cap.active)
    return {
      tone: "neutral",
      // Windows policy already does what this step would do: nothing is missing, so it is not "unavailable".
      label: cap.code === "policy" ? "already off by policy" : "already on",
      reason: cap.detail,
    };
  const asksAdmin = id === "pauseServices" || id === "standbyPurge";
  return {
    tone: "lime",
    label: asksAdmin ? "applies (asks for admin)" : "applies",
    reason:
      id === "priority"
        ? `${note}; skipped if the game already runs higher.`
        : asksAdmin
          ? cap.detail
          : (note ?? cap.detail),
  };
}
export const referenceTargets = [
  { host: "1.1.1.1", label: "Cloudflare DNS" },
  { host: "8.8.8.8", label: "Google DNS" },
  { host: "9.9.9.9", label: "Quad9 DNS" },
];
export const hostPattern =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9A-Fa-f:.]+)$/;
// Suggested background apps; voice chat, capture and launchers are never suggested.
export const suggestions: [RegExp, Background[number]["action"], string][] = [
  [
    /^(chrome|msedge|firefox|opera|opera_gx|brave|vivaldi)\.exe$/i,
    "lower",
    "browser",
  ],
  [
    /^(onedrive|dropbox|googledrivefs|megasync|icloud\w*)\.exe$/i,
    "suspend",
    "cloud sync",
  ],
  [/updat/i, "suspend", "updater"],
];
export const neverSuggest =
  /^(discord|teamspeak|ts3client|mumble|skype|teams|ms-teams|zoom|slack|obs|steam|epicgameslauncher|galaxyclient)/i;
export type Status = Response<"boostStatus">;
/** Position on the Everyday to Game performance scale; Custom is off the scale. */
export const intensity: Record<BoostMode, number> = {
  off: 0,
  balanced: 1,
  performance: 2,
  competitive: 3,
  custom: -1,
};
export const scale: BoostMode[] = [
  "off",
  "balanced",
  "performance",
  "competitive",
];
export const tagline: Partial<Record<BoostMode, string>> = {
  balanced: "Smoother gameplay with light, safe tuning of the game itself.",
  performance: "Adds a performance power plan and lowers background apps.",
  competitive:
    "Adds suspending apps, finer timers, core unparking and service pausing.",
  custom: "Build your own set: every mechanism is yours to choose.",
};
