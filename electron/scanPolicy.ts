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

// A bare drive root ("D:\\") must never match: it is an ancestor of everything.
const isRoot = (p: string) => {
  const { root } = path.parse(p);
  return root !== "" && pathKey(path.normalize(p)) === pathKey(root);
};
const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent + path.sep);

/**
 * Drops dismissed entries that cover the given paths.
 * "ancestors" (a hand-picked game): an entry equal to, or a parent of, a path. The picked folder is
 * often deeper than the scanner's install root, but its siblings and parents' other games stay removed.
 * "both" (a chosen folder scan): entries below a path are cleared too.
 */
export function undismissPaths(
  list: Dismissed[],
  paths: string[],
  direction: "ancestors" | "both" = "ancestors",
): Dismissed[] {
  const keys = paths.filter((p) => !isRoot(p)).map(pathKey);
  return list.filter((x) => {
    const entry = pathKey(x.path);
    return (
      isRoot(x.path) ||
      !keys.some(
        (key) =>
          within(key, entry) || (direction === "both" && within(entry, key)),
      )
    );
  });
}

export function readDismissed(value: unknown): Dismissed[] {
  return Array.isArray(value)
    ? value.filter(
        (x): x is Dismissed =>
          !!x && typeof x === "object" && typeof x.path === "string",
      )
    : [];
}
