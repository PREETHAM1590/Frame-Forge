// Boost start clean-up, planned in Node because the never-touch list (voice chat, audio, input, security, launchers) lives here.
// The helper receives only what is safe; it still re-checks the session, owner and protected lists for every process.
import { neverTouch } from "./background.js";
import type { BoosterConfig, RunningProcess } from "./contracts.js";

type Rules = BoosterConfig["background"];
export const trimMinBytes = 100 * 1024 * 1024;
export const graceSeconds = 5;

export interface CleanupBlocked {
  image: string;
  action: Rules[number]["action"];
  reason: string;
}
export interface CleanupPlan {
  rules: Rules;
  trim: string[];
  graceSeconds: number;
  relaunch: boolean;
  purge: boolean;
  trimMinBytes: number;
}

/**
 * Splits the apps list into what the clean-up does (close, end, pause), what stays for the normal "lower" mechanism, and what is
 * never touched. Trim targets are background programs holding more than 100 MB that are not the game or never-touch.
 */
export function planCleanup(input: {
  rules: Rules;
  processes: readonly RunningProcess[];
  gameImage?: string;
  relaunch: boolean;
  purge: boolean;
}): { plan: CleanupPlan; lower: Rules; blocked: CleanupBlocked[] } {
  const rules: Rules = [];
  const lower: Rules = [];
  const blocked: CleanupBlocked[] = [];
  for (const rule of input.rules) {
    if (rule.action === "lower") {
      lower.push(rule);
      continue;
    }
    const reason = neverTouch(rule.image);
    if (reason)
      blocked.push({ image: rule.image, action: rule.action, reason });
    else rules.push(rule);
  }
  const game = input.gameImage?.toLowerCase();
  const trim = new Set<string>();
  for (const p of input.processes) {
    const image = p.image.toLowerCase();
    if (
      p.protected ||
      (p.workingSetBytes ?? 0) < trimMinBytes ||
      image === game ||
      neverTouch(p.image)
    )
      continue;
    trim.add(p.image);
  }
  return {
    plan: {
      rules,
      trim: [...trim].slice(0, 100),
      graceSeconds,
      relaunch: input.relaunch,
      purge: input.purge,
      trimMinBytes,
    },
    lower,
    blocked,
  };
}
