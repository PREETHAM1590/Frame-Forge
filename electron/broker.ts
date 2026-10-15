import type { BrokerStatus } from "../shared/contracts.js";
// Settings > Administrator access ("approve admin once"). The helper decides, per request, whether the FrameforgeBroker service
// can take it (and otherwise opens the usual Windows prompt); this class only keeps the last status the helper reported so the
// elevation gate and auto-boost know whether administrator steps can run without a prompt. See docs/SECURITY.md.
export type BrokerCommand =
  "broker-status" | "broker-install" | "broker-remove";
export type BrokerCall = (command: BrokerCommand) => Promise<BrokerStatus>;
export const brokerUnsupported: BrokerStatus = {
  state: "unsupported",
  message: "Admin access is available in the installed Windows app.",
};
/** How long a status is trusted before the next use asks again in the background. */
const staleMs = 60000;
export class BrokerController {
  private current: BrokerStatus = brokerUnsupported;
  private at = 0;
  private refreshing: Promise<BrokerStatus> | null = null;
  constructor(
    private readonly call: BrokerCall,
    private readonly now: () => number = Date.now,
  ) {}
  get status() {
    return this.current;
  }
  /** True only when the service is installed, registered to this user and this helper, running and answering. */
  get ready() {
    return this.current.state === "ready";
  }
  /** Like `ready`, and re-reads the status in the background when it is more than a minute old. */
  get silent() {
    if (this.now() - this.at > staleMs) void this.refresh().catch(() => {});
    return this.ready;
  }
  /** Read-only: a service-manager query, an HKLM read and a ping. Never opens a Windows prompt. */
  refresh() {
    this.refreshing ??= this.take("broker-status").finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  /** One Windows prompt. */
  install() {
    return this.take("broker-install");
  }
  /** One Windows prompt. */
  remove() {
    return this.take("broker-remove");
  }
  private async take(command: BrokerCommand) {
    try {
      this.current = await this.call(command);
    } catch (error) {
      // A failed install or removal says why, but the stored status must follow what Windows really has.
      if (command !== "broker-status") await this.refresh().catch(() => {});
      else
        this.current = {
          state: "unhealthy",
          message: "The admin service could not be checked.",
        };
      this.at = this.now();
      if (command !== "broker-status") throw error;
      return this.current;
    }
    this.at = this.now();
    return this.current;
  }
}
