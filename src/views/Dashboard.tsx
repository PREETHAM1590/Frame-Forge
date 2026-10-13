import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { LinkButton, formatTime } from "../components/ui";
import { request } from "../api";
import { useScan } from "../useScan";
import type { RestoreStatus } from "../../shared/contracts";
import { catalogue, securityIds } from "../../shared/catalogue";
import type { ViewProps } from "../types";
import { Hero } from "./dashboard/Hero";
import type { DashboardState } from "./dashboard/Hero";
import { Alerts } from "./dashboard/Alerts";
import { BoostPanel } from "./dashboard/BoostPanel";
import { Matrix } from "./dashboard/Matrix";
import { QuickActions } from "./dashboard/QuickActions";
import { RecentActivity } from "./dashboard/RecentActivity";

const cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

export function Dashboard({
  data,
  navigate,
  preview,
  run,
  pending,
}: ViewProps) {
  const h = data.hardware;
  const { running, progress } = useScan(data);
  const [restore, setRestore] = useState<RestoreStatus | null>(null);
  useEffect(() => {
    let active = true;
    void request("restoreStatus", {})
      .then((value) => active && setRestore(value))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  // Applied and not rolled back: still lowering security, or still waiting for a restart.
  const live = data.activity.filter(
    (a) => a.status === "success" && a.rollback,
  );
  const lowered = live.filter((a) =>
    a.ids.some((id) => securityIds.includes(id)),
  );
  const bootedAt = Date.parse(data.bootedAt);
  const awaitingRestart = live.flatMap((a) =>
    Date.parse(a.at) > bootedAt || !bootedAt
      ? a.ids
          .map((id) => catalogue.find((o) => o.id === id))
          .filter((o) => o?.restart === "reboot")
          .map((o) => o!.name)
      : [],
  );
  const [restoring, setRestoring] = useState(false);
  async function restoreSecurity() {
    setRestoring(true);
    try {
      // Newest first, one administrator prompt per item; stop at the first failure so nothing is skipped silently.
      for (const row of lowered)
        if (!(await run("rollback", { id: row.id, confirmed: true }))) break;
    } finally {
      setRestoring(false);
    }
  }
  const nameOf = (id: string) => catalogue.find((o) => o.id === id)?.name;
  const loweredNames = lowered
    .flatMap((a) => a.ids)
    .filter((id) => securityIds.includes(id))
    .map(nameOf)
    .filter((n): n is string => !!n);
  const driftedNames = [...new Set(data.drifted.flatMap((d) => d.ids))]
    .map(nameOf)
    .filter((n): n is string => !!n);
  const restartNames = [...new Set(awaitingRestart)];
  const state: DashboardState =
    loweredNames.length || driftedNames.length
      ? "attention"
      : data.boost.session
        ? "boost"
        : "nominal";
  return (
    <div className="dashboard">
      <Hero
        state={state}
        modeLabel={cap(data.state.booster.mode)}
        autoBoost={data.state.booster.autoBoost}
        source={
          h.source === "demo"
            ? "Demo hardware"
            : h.source === "windows"
              ? "Windows readings"
              : "Partial readings"
        }
        sourceTone={h.source === "demo" ? "amber" : "cyan"}
      />
      <Alerts
        loweredNames={loweredNames}
        driftedNames={driftedNames}
        restartNames={restartNames}
        busy={pending || restoring}
        onRestoreSecurity={() => void restoreSecurity()}
      />
      <div className="dash-main">
        <BoostPanel data={data} onOpen={() => navigate("Game Mode")} />
        <Matrix h={h} />
      </div>
      <div className="dash-lower">
        <QuickActions
          data={data}
          restore={restore}
          scanning={running}
          scanProgress={progress}
          busy={pending}
          onPointer={() => preview(["mouse-precision"])}
          onScan={() => void run("detectGames", {}, "Game scan finished.")}
          onNavigate={navigate}
        />
        <RecentActivity
          activity={data.activity}
          onViewAll={() => navigate("Activity")}
        />
      </div>
      <div className="system-strip">
        <span>
          <Monitor size={16} />
          {h.os || "Windows version unavailable"}
        </span>
        <span>Read {formatTime(h.collectedAt)}</span>
        <LinkButton onClick={() => navigate("System")}>
          System details
        </LinkButton>
      </div>
    </div>
  );
}
