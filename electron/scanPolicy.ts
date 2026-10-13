import type { Settings } from "../shared/contracts.js";

export const lastScanKey = "lastGameScanAt";
export const dismissedKey = "dismissedGamePaths";
export const maxDismissed = 1000;
const hour = 3600_000;

/** First launch (no scan recorded) or last scan older than the interval; a future timestamp counts as stale. */
export function shouldAutoScan(
  lastScanAt: unknown,
  settings: Pick<Settings, "autoScan" | "autoScanHours">,
  now: number,
): boolean {
  if (!settings.autoScan) return false;
  const last = typeof lastScanAt === "string" ? Date.parse(lastScanAt) : NaN;
  return (
    Number.isNaN(last) ||
    last > now ||
    now - last >= settings.autoScanHours * hour
  );
}

export const pathKey = (p: string) => p.toLowerCase();

/** Newest last, de-duplicated, capped. */
export function dismissPath(list: string[], p: string): string[] {
  return [...list.filter((x) => x !== pathKey(p)), pathKey(p)].slice(
    -maxDismissed,
  );
}

export function readDismissed(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : [];
}
