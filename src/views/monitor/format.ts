const units = ["B", "KB", "MB", "GB", "TB"];
/** 1536 -> "1.5 KB". Whole numbers from 100 up so columns stay narrow. */
export function formatSize(bytes: number) {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
export const formatRate = (bytesPerSec: number) =>
  `${formatSize(bytesPerSec)}/s`;
/** Link speed in bits per second, as network tools show it: 1000000000 -> "1 Gbit/s". */
export function formatLink(bitsPerSec: number) {
  if (bitsPerSec >= 1e9) return `${+(bitsPerSec / 1e9).toFixed(1)} Gbit/s`;
  return `${Math.round(bitsPerSec / 1e6)} Mbit/s`;
}
export const percent = (n: number) => `${n.toFixed(n >= 10 ? 0 : 1)}%`;
export const fpsText = (n: number | null) => (n === null ? "-" : n.toFixed(0));
