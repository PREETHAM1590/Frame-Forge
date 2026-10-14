import { useEffect, useState } from "react";
import { onEvent, request } from "./api";
import type { MonitorSample } from "../shared/contracts";
/** Samples kept for the charts: one minute at one reading a second. */
export const historyLength = 60;
/** No reading for this long while the page is visible means the helper stopped; the page offers a retry. */
const stallMs = 6000;
export type MonitorStatus = "starting" | "live" | "stalled" | "unavailable";
export interface MonitorFeed {
  samples: MonitorSample[];
  status: MonitorStatus;
  error: string;
  retry: () => void;
}
/** True while the window is shown. A minimized or covered window, or another page's tab, reads as hidden. */
export function usePageVisible() {
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}
/**
 * Live counters. The helper runs only between monitorStart and monitorStop: it starts when this page mounts while the window is visible,
 * and stops (the process ends, not just pauses) when the window is hidden or the page is left.
 */
export function useMonitorFeed(): MonitorFeed {
  const visible = usePageVisible();
  const [attempt, setAttempt] = useState(0);
  const [samples, setSamples] = useState<MonitorSample[]>([]);
  const [status, setStatus] = useState<MonitorStatus>("starting");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!visible) return;
    let live = true;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => live && setStatus("stalled"), stallMs);
    };
    const off = onEvent((event) => {
      if (event.type !== "monitor") return;
      setSamples((old) => [...old, event.sample].slice(-historyLength));
      setStatus("live");
      watch();
    });
    watch();
    request("monitorStart", {}).catch((e: unknown) => {
      if (!live) return;
      clearTimeout(watchdog);
      setStatus("unavailable");
      setError(
        e instanceof Error ? e.message : "The live monitor could not start.",
      );
    });
    return () => {
      live = false;
      clearTimeout(watchdog);
      off();
      void request("monitorStop", {}).catch(() => undefined);
    };
  }, [visible, attempt]);
  return {
    samples,
    status: visible ? status : "starting",
    error,
    retry: () => {
      setStatus("starting");
      setError("");
      setAttempt((n) => n + 1);
    },
  };
}
