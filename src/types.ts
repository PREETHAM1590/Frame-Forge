import type { ScanState } from "./useScan";
import type {
  Bootstrap,
  Method,
  Request,
  Response,
  OperationId,
} from "../shared/contracts";
export type Page =
  | "Dashboard"
  | "Optimizations"
  | "Presets"
  | "Game library"
  | "Game Mode"
  | "Restore & backups"
  | "System"
  | "Monitor"
  | "Activity"
  | "Settings"
  | "Health Check";
export interface ViewProps {
  data: Bootstrap;
  /** True while any request except an elevated Windows restore request is running. */
  pending: boolean;
  /** True while an elevated restore request waits on the administrator prompt; only restore actions are gated on it. */
  restorePending: boolean;
  /** True while the Windows 11 timer setting waits on its administrator prompt; only that control is gated on it. */
  timerPending?: boolean;
  run: <M extends Method>(
    method: M,
    input: Request<M>,
    message?: string,
  ) => Promise<Response<M> | undefined>;
  navigate: (page: Page) => void;
  preview: (ids: OperationId[]) => void;
  /** Live game-scan state, owned by App so it is never behind a page's own subscription. */
  scan: ScanState;
}
