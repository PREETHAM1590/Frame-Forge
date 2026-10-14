// Cleanup selection rules and wording. Preview comes first; nothing is selected until the user picks it.
import type { CleanupId, CleanupPreview } from "./contracts.js";

type Row = CleanupPreview["categories"][number];

export const shaderWarning =
  "Shader caches are rebuilt by the game. Expect a brief stutter or longer loading the first time each game starts afterwards.";

/** A category can be selected when its folder exists and Frameforge is allowed to clean it. */
export const selectable = (row: Row) => row.present && !row.needsAdmin;

export function selectedBytes(
  preview: CleanupPreview,
  ids: readonly CleanupId[],
) {
  return preview.categories
    .filter((r) => ids.includes(r.id) && selectable(r))
    .reduce((n, r) => n + (r.bytes ?? 0), 0);
}

/** Only ids that are selectable in this preview, in preview order. */
export function effectiveSelection(
  preview: CleanupPreview,
  ids: readonly CleanupId[],
): CleanupId[] {
  return preview.categories
    .filter((r) => ids.includes(r.id) && selectable(r))
    .map((r) => r.id);
}

export const needsShaderWarning = (
  preview: CleanupPreview,
  ids: readonly CleanupId[],
) =>
  preview.categories.some(
    (r) => r.shader && ids.includes(r.id) && selectable(r),
  );

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
