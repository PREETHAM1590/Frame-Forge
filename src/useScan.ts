import { useEffect, useState } from "react";
import { onEvent } from "./api";
import type { Bootstrap } from "../shared/contracts";

export type ScanProgress = {
  launcher: string;
  done: number;
  total: number;
  found: number;
};

export type ScanState = { running: boolean; progress: ScanProgress | null };

/**
 * Live state of the whole-PC game scan. Called once by App (whose subscription exists from
 * mount, before any page renders) and passed to pages, so no event can arrive between a
 * page rendering and its own effect subscribing, and progress survives page changes.
 */
export function useScan(data: Pick<Bootstrap, "scan"> | null): ScanState {
  const [running, setRunning] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "scan") {
          setRunning(event.phase === "started");
          if (event.phase === "finished") setProgress(null);
        } else if (event.type === "scan-progress") setProgress(event);
      }),
    [],
  );
  return { running: running ?? data?.scan.running ?? false, progress };
}
