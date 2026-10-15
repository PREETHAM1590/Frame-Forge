import { useCallback, useEffect, useState } from "react";
import { request } from "./api";
import type { HealthReport } from "../shared/contracts";

// One report for the whole renderer: the Health Check page and the Dashboard card share it, and it is reused for a few minutes
// so opening the Dashboard does not read the PC again every time.
const maxAgeMs = 5 * 60 * 1000;
let cached: { report: HealthReport; at: number } | null = null;
let inflight: Promise<HealthReport> | null = null;
// A failed read is not retried by itself (it would loop); the person presses Run again.
let failedAt = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function readHealth(): Promise<HealthReport> {
  inflight ??= request("healthCheck", {})
    .then((report) => {
      cached = { report, at: Date.now() };
      return report;
    })
    .finally(() => {
      inflight = null;
      notify();
    });
  notify();
  return inflight;
}
export function clearHealth() {
  cached = null;
  failedAt = 0;
  notify();
}

/** `auto`: read when nothing fresh is cached (desktop only). Errors are returned as text, never thrown. */
export function useHealth(auto: boolean) {
  const [, tick] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  // setState only after the read settles, so the effect below never sets state while it runs.
  const refresh = useCallback(
    () =>
      readHealth()
        .then(() => setError(""))
        .catch((e) => {
          failedAt = Date.now();
          setError(
            e instanceof Error ? e.message : "The health check could not run.",
          );
        }),
    [],
  );
  const at = cached?.at ?? 0;
  useEffect(() => {
    const fresh = at > 0 && Date.now() - at < maxAgeMs;
    if (auto && !fresh && !inflight && Date.now() - failedAt > maxAgeMs)
      void refresh();
  }, [auto, at, refresh]);
  return {
    report: cached?.report ?? null,
    loading: inflight !== null,
    error,
    refresh,
  };
}
