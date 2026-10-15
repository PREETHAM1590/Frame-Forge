// GPU driver age and the fixed vendor pages. Nothing here looks up the newest driver: only the installed one's age is known.
import type { DriverVendor } from "./contracts.js";

/** The only pages Frameforge opens for drivers. The window sends a vendor name, never a URL. */
export const driverPages: Record<DriverVendor, string> = {
  nvidia: "https://www.nvidia.com/drivers",
  amd: "https://www.amd.com/en/support",
  intel: "https://www.intel.com/content/www/us/en/support/detect.html",
};
export const driverPageName: Record<DriverVendor, string> = {
  nvidia: "NVIDIA drivers page",
  amd: "AMD support page",
  intel: "Intel Driver & Support Assistant",
};

export interface DriverAge {
  days: number | null;
  text: string;
  /** "old" at 12 months or more, "aging" at 6 months or more. */
  level: "unknown" | "recent" | "aging" | "old";
}

export function driverAge(
  date: string | null,
  now: Date = new Date(),
): DriverAge {
  const t = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(t))
    return { days: null, text: "Driver date unknown", level: "unknown" };
  const days = Math.max(0, Math.floor((now.getTime() - t) / 86400000));
  const months = Math.floor(days / 30.4);
  const text =
    days < 1
      ? "Released today"
      : days < 60
        ? `${days} days old`
        : months < 24
          ? `${months} months old`
          : `${Math.floor(days / 365)} years old`;
  return {
    days,
    text,
    level: days >= 365 ? "old" : days >= 182 ? "aging" : "recent",
  };
}
