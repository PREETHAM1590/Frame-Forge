import { useCallback, useEffect, useState } from "react";
import { onEvent, request } from "./api";
import type { SmartStatus } from "../shared/contracts";
import { bottleneckFor, setBottleneckSource } from "../shared/smart";
import { setBottleneckProvider } from "../shared/gameSettings";

const empty: SmartStatus = { observing: null, profiles: [], candidate: null };
let latest: SmartStatus = empty;
// The per-game settings guide reads what Smart mode learned for a game ("capped" is not a hardware limit, so it gives no hint).
setBottleneckSource(
  (id) => latest.profiles.find((p) => p.gameId === id)?.classification ?? null,
);
setBottleneckProvider((id) => {
  const b = bottleneckFor(id);
  return b === "capped" ? null : b;
});

/** Smart mode state: what it is watching, what it learned per game, and a game it found that is not in the library yet. */
export function useSmart(): {
  status: SmartStatus;
  set: (next: SmartStatus) => void;
  reload: () => void;
} {
  const [status, setStatus] = useState<SmartStatus>(latest);
  const set = useCallback((next: SmartStatus) => {
    latest = next;
    setStatus(next);
  }, []);
  const reload = useCallback(() => {
    void request("smartStatus", {})
      .then(set)
      .catch(() => undefined);
  }, [set]);
  useEffect(() => {
    reload();
    return onEvent((event) => {
      if (event.type === "smart") set(event.status);
    });
  }, [reload, set]);
  return { status, set, reload };
}
