import { useSyncExternalStore } from "react";
import type { OperationId } from "../shared/contracts";

/** Switch flips waiting for "Review & save". Lives outside React state so App can guard navigation. */
export type Pending = Partial<Record<OperationId, "on" | "off">>;
let current: Pending = {};
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const pendingStore = {
  get: () => current,
  count: () => Object.keys(current).length,
  set(next: Pending) {
    current = next;
    listeners.forEach((fn) => fn());
  },
  clear() {
    this.set({});
  },
};
export const usePending = () =>
  useSyncExternalStore(subscribe, pendingStore.get);
