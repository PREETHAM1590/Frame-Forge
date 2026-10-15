import { useCallback, useEffect, useState } from "react";
import { onEvent, request } from "./api";
import type { SmartStatus } from "../shared/contracts";

const empty: SmartStatus = { observing: null, profiles: [], candidate: null };

/** Smart mode state: what it is watching, what it learned per game, and a game it found that is not in the library yet. */
export function useSmart(): {
  status: SmartStatus;
  set: (next: SmartStatus) => void;
  reload: () => void;
} {
  const [status, set] = useState<SmartStatus>(empty);
  const reload = useCallback(() => {
    void request("smartStatus", {})
      .then(set)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
    return onEvent((event) => {
      if (event.type === "smart") set(event.status);
    });
  }, [reload]);
  return { status, set, reload };
}
