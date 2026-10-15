import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Badge, Busy, Button, Disclosure } from "./ui";
import { request } from "../api";
import type { BrokerStatus } from "../../shared/contracts";
const tones = {
  ready: "lime",
  "needs-update": "amber",
  unhealthy: "red",
  "not-installed": "neutral",
  unsupported: "neutral",
} as const;
const labels: Record<BrokerStatus["state"], string> = {
  ready: "Approved",
  "needs-update": "Needs approval again",
  unhealthy: "Not working",
  "not-installed": "Not set up",
  unsupported: "Unavailable",
};
/** Settings > Administrator access: "approve admin once" through the optional FrameforgeBroker service. */
export function AdminAccess({
  disabled = false,
  defaultOpen = true,
}: {
  disabled?: boolean;
  defaultOpen?: boolean;
}) {
  const [status, setStatus] = useState<BrokerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request("brokerStatus", {})
      .then((s) => active && setStatus(s))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  async function act(method: "brokerInstall" | "brokerRemove") {
    setBusy(true);
    setError("");
    try {
      setStatus(await request(method, { confirmed: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
      // Whatever happened, show what Windows really has now.
      await request("brokerStatus", {})
        .then(setStatus)
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  const state = status?.state ?? "unsupported";
  const installed = state !== "not-installed" && state !== "unsupported";
  return (
    <Disclosure
      heading
      icon={<KeyRound size={20} />}
      title="Administrator access"
      defaultOpen={defaultOpen}
    >
      <div className="setting-row">
        <div>
          <strong>
            Approve admin once{" "}
            <Badge tone={tones[state]}>{labels[state]}</Badge>
          </strong>
          <p className="muted">
            {status?.message ?? "Checking the admin service…"}
          </p>
          <p className="muted">
            Off by default. Without it, each step that needs administrator
            rights (restore points, pausing services, clearing the standby list,
            machine-wide optimizations, FPS capture, switching machine-wide
            startup apps; items that lower Windows security always ask) asks
            Windows for approval every time. Turning it on installs a small
            Windows service, run by Windows as the system, after one approval.
            It does only those allowlisted steps and only for Frameforge on your
            account, but it is a privileged component that stays installed until
            you remove it. Removing it is one approval too.
          </p>
          {error && <p role="alert">{error}</p>}
        </div>
        <div className="row-actions">
          {busy && <Busy label="Waiting for Windows" />}
          {(state === "not-installed" ||
            state === "needs-update" ||
            state === "unhealthy") && (
            <Button
              variant="primary"
              disabled={busy || disabled}
              onClick={() => void act("brokerInstall")}
            >
              {state === "not-installed"
                ? "Approve admin once"
                : "Approve again"}
            </Button>
          )}
          {installed && (
            <Button
              variant="danger"
              disabled={busy || disabled}
              onClick={() => void act("brokerRemove")}
            >
              Remove admin service
            </Button>
          )}
        </div>
      </div>
    </Disclosure>
  );
}
