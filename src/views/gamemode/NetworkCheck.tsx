import { useState } from "react";
import { Button } from "../../components/ui";
import { request } from "../../api";
import type { NetworkCheck as NetworkResult } from "../../../shared/contracts";
import { hostPattern, referenceTargets } from "./model";

/** Diagnostics only: nothing on the PC is changed. */
export function NetworkCheck({
  unavailable,
  demo,
}: {
  unavailable: string;
  demo: boolean;
}) {
  const [netHost, setNetHost] = useState("");
  const [netBusy, setNetBusy] = useState(false);
  const [netResult, setNetResult] = useState<NetworkResult | null>(null);
  const [netError, setNetError] = useState("");
  const hostTrimmed = netHost.trim();
  const hostValid =
    hostTrimmed.length > 0 &&
    hostTrimmed.length <= 253 &&
    hostPattern.test(hostTrimmed);
  const checkNetwork = async (host: string) => {
    setNetBusy(true);
    setNetError("");
    setNetResult(null);
    try {
      setNetResult(await request("networkCheck", { host, count: 10 }));
    } catch (error) {
      setNetError(
        error instanceof Error ? error.message : "The network check failed.",
      );
    } finally {
      setNetBusy(false);
    }
  };
  return (
    <section className="gm-sub" aria-label="Network check">
      <p className="muted">
        Diagnostics only: sends 10 ICMP pings to one host and reports latency,
        jitter and packet loss. Nothing on your PC is changed. It measures the
        path to that host, not your game traffic, and some hosts ignore pings.
        Enter the address of your game server or region if you know it; the
        buttons are public reference targets, not game servers.
      </p>
      <div className="toolbar">
        <label className="field">
          Host name or IP address
          <input
            type="text"
            value={netHost}
            maxLength={253}
            placeholder="example.com or 203.0.113.5"
            disabled={netBusy}
            onChange={(e) => setNetHost(e.target.value)}
          />
        </label>
        <Button
          variant="primary"
          disabled={netBusy || !hostValid || !!unavailable || demo}
          title={
            unavailable ||
            (!hostValid ? "Enter a valid host name or IP address." : undefined)
          }
          onClick={() => void checkNetwork(hostTrimmed)}
        >
          {netBusy ? "Checking…" : "Check network"}
        </Button>
      </div>
      <div className="booster-chips" aria-label="Reference targets">
        {referenceTargets.map((t) => (
          <Button
            key={t.host}
            disabled={netBusy || !!unavailable}
            title={unavailable || `Ping ${t.host} (${t.label}).`}
            onClick={() => {
              setNetHost(t.host);
              void checkNetwork(t.host);
            }}
          >
            {t.label} ({t.host})
          </Button>
        ))}
      </div>
      {netError && (
        <p className="notice" role="alert" data-error="true">
          {netError}
        </p>
      )}
      {netResult && (
        <div role="status" aria-label="Network check result">
          <ul className="mechanism-list">
            <li>
              <span>Host</span>
              <strong>
                {netResult.host}
                {netResult.address ? ` (${netResult.address})` : ""}
              </strong>
            </li>
            <li>
              <span>Replies</span>
              <strong>
                {netResult.received} of {netResult.sent}
              </strong>
            </li>
            <li>
              <span>Packet loss</span>
              <strong>{netResult.lossPercent}%</strong>
            </li>
            <li>
              <span>Latency (min / avg / max)</span>
              <strong>
                {netResult.avgMs === null
                  ? "no replies"
                  : `${netResult.minMs} / ${netResult.avgMs} / ${netResult.maxMs} ms`}
              </strong>
            </li>
            <li>
              <span>Jitter</span>
              <strong>
                {netResult.jitterMs === null
                  ? "n/a"
                  : `${netResult.jitterMs} ms`}
              </strong>
            </li>
          </ul>
          <p className="muted">{netResult.message}</p>
        </div>
      )}
    </section>
  );
}
