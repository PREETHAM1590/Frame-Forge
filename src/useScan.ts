import { useEffect, useState } from "react";
import { onEvent } from "./api";
import type { Bootstrap } from "../shared/contracts";

export type ScanProgress = {
  launcher: string;
  done: number;
  total: number;
  found: number;
};

// Kept across page changes so progress is still there when the library opens mid-scan.
let latest: ScanProgress | null = null;

/** Live state of the whole-PC game scan, shared by the Dashboard and the library. */
export function useScan(data: Pick<Bootstrap, "scan">) {
  const [running, setRunning] = useState(data.scan.running);
  const [progress, setProgress] = useState<ScanProgress | null>(latest);
  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "scan") {
          setRunning(event.phase === "started");
          if (event.phase === "finished") setProgress((latest = null));
        } else if (event.type === "scan-progress")
          setProgress((latest = event));
      }),
    [],
  );
  return { running, progress };
}
