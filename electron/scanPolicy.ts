import path from "node:path";
import type { Game, Settings } from "../shared/contracts.js";

export const lastScanKey = "lastGameScanAt";
/** True when the last scan skipped a source; the next one is due sooner. */
export const partialScanKey = "lastGameScanPartial";
export const dismissedKey = "dismissedGameList";
export const maxDismissed = 1000;
const hour = 3600_000;

/**
 * First launch (no scan recorded) or last scan older than the interval; a future timestamp counts as stale.
 * After a partial scan (some source failed) only an hour has to pass.
 */
export function shouldAutoScan(
  lastScanAt: unknown,
  settings: Pick<Settings, "autoScan" | "autoScanHours">,
  now: number,
  partial = false,
): boolean {
  if (!settings.autoScan) return false;
  const last = typeof lastScanAt === "string" ? Date.parse(lastScanAt) : NaN;
  const wait = Math.min(settings.autoScanHours, partial ? 1 : Infinity) * hour;
  return Number.isNaN(last) || last > now || now - last >= wait;
}

export const pathKey = (p: string) => p.toLowerCase();

/** What is needed to bring a removed game back. */
export type Dismissed = Pick<
  Game,
  "name" | "path" | "source" | "executablePath"
>;

export const toDismissed = (g: Game): Dismissed => ({
  name: g.name,
  path: g.path,
  source: g.source,
  executablePath: g.executablePath,
});

/** Newest last, one entry per path, capped. */
export function dismissGame(list: Dismissed[], game: Dismissed): Dismissed[] {
  return [
    ...list.filter((x) => pathKey(x.path) !== pathKey(game.path)),
    game,
  ].slice(-maxDismissed);
}

const nested = (a: string, b: string) =>
  a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

/**
 * Drops every dismissed entry equal to, inside or above any of `paths` (a hand-picked game's
 * folder is often not the scanner's install root, so exact matching would miss it).
 */
export function undismissPaths(
  list: Dismissed[],
  paths: string[],
): Dismissed[] {
  const keys = paths.map(pathKey);
  return list.filter((x) => !keys.some((key) => nested(pathKey(x.path), key)));
}

export function readDismissed(value: unknown): Dismissed[] {
  return Array.isArray(value)
    ? value.filter(
        (x): x is Dismissed =>
          !!x && typeof x === "object" && typeof x.path === "string",
      )
    : [];
}
