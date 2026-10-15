import { Suspense, lazy, useState, useEffect, useCallback } from "react";
import {
  LayoutDashboard,
  SlidersHorizontal,
  Layers,
  Gamepad2,
  Play,
  Archive,
  Cpu,
  Activity as ActivityIcon,
  History,
  Settings as SettingsIcon,
  Flame,
  ChevronRight,
  RefreshCw,
  AlertTriangle,
  HeartPulse,
} from "lucide-react";
import { onEvent, request } from "./api";
import { UpdateCard } from "./components/UpdatePanel";
import { useScan } from "./useScan";
import type { Bootstrap, Method, Request, Response } from "../shared/contracts";
import type { Page, ViewProps } from "./types";
import {
  Button,
  Badge,
  Busy,
  Toast,
  NavRail,
  TopBar,
  PageTransition,
} from "./components/ui";
import type { RailItem } from "./components/ui";
import { clearGameIcons } from "./components/GameIcon";
import { Dashboard } from "./views/Dashboard";
import { ApplyFlowDialog } from "./views/optimizations/ApplyFlowDialog";
import { useApplyFlow } from "./views/optimizations/useApplyFlow";
import { Backups, ActivityLog, restoreRecoveryRow } from "./views/Recovery";
// Heavy pages load on first visit, so the renderer only holds what is on screen (Dashboard is the landing page).
const Optimizations = lazy(() =>
  import("./views/Optimizations").then((m) => ({ default: m.Optimizations })),
);
const Presets = lazy(() =>
  import("./views/Optimizations").then((m) => ({ default: m.Presets })),
);
const Games = lazy(() =>
  import("./views/Games").then((m) => ({ default: m.Games })),
);
const GameMode = lazy(() =>
  import("./views/Games").then((m) => ({ default: m.GameMode })),
);
const System = lazy(() =>
  import("./views/System").then((m) => ({ default: m.System })),
);
const Settings = lazy(() =>
  import("./views/System").then((m) => ({ default: m.Settings })),
);
const Monitor = lazy(() =>
  import("./views/Monitor").then((m) => ({ default: m.Monitor })),
);
const HealthCheck = lazy(() =>
  import("./views/HealthCheck").then((m) => ({ default: m.HealthCheck })),
);
// These can sit behind a Windows administrator prompt for minutes, so they must not lock the rest of the app.
const elevatedMethods: ReadonlySet<Method> = new Set([
  "createRestorePoint",
  "restorePoints",
  "enableSystemProtection",
  "recoverRestoreFrequency",
  "openSystemRestore",
]);
// Eight rail entries; Presets and Activity sit under their parent so every page stays one click away.
const navigation: readonly RailItem<Page>[] = [
  { page: "Dashboard", label: "Dashboard", icon: LayoutDashboard, index: "01" },
  { page: "Game Mode", label: "Game Mode", icon: Play, index: "02" },
  { page: "Game library", label: "Game library", icon: Gamepad2, index: "03" },
  {
    page: "Optimizations",
    label: "Optimizations",
    icon: SlidersHorizontal,
    index: "04",
  },
  { page: "Presets", label: "Presets", icon: Layers, child: true },
  {
    page: "Restore & backups",
    label: "Restore & backups",
    icon: Archive,
    index: "05",
  },
  { page: "Activity", label: "Activity", icon: History, child: true },
  { page: "System", label: "System", icon: Cpu, index: "06" },
  { page: "Monitor", label: "Monitor", icon: ActivityIcon, index: "07" },
  {
    page: "Health Check",
    label: "Health Check",
    icon: HeartPulse,
    index: "08",
  },
];
const settingsItem: RailItem<Page> = {
  page: "Settings",
  label: "Settings",
  icon: SettingsIcon,
  index: "SYS",
};
export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState<Page>("Dashboard");
  const [mobile, setMobile] = useState(false);
  const [requestsPending, setRequestsPending] = useState(0);
  const [restoreRequests, setRestoreRequests] = useState(0);
  const [timerRequests, setTimerRequests] = useState(0);
  const scan = useScan(data);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const load = useCallback(async () => {
    try {
      setData(await request("bootstrap", {}));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load local data.");
    }
  }, []);
  useEffect(() => {
    let active = true;
    void request("bootstrap", {})
      .then((value) => {
        if (active) {
          setData(value);
          setError("");
        }
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : "Unable to load local data.",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  // One app-wide subscription keeps every page (Dashboard, library, banner) in step with the booster.
  useEffect(
    () =>
      onEvent((event) => {
        // A finished scan may have added games; refresh the library and its icons.
        if (event.type === "scan") {
          if (event.phase === "started")
            setData((old) =>
              old ? { ...old, scan: { ...old.scan, running: true } } : old,
            );
          if (event.phase === "finished") {
            clearGameIcons();
            void request("bootstrap", {})
              .then(setData)
              .catch(() => undefined);
          }
          return;
        }
        if (event.type === "state") {
          void request("bootstrap", {})
            .then(setData)
            .catch(() => undefined);
          return;
        }
        // A finished FPS capture wrote an Activity row.
        if (event.type === "fps") {
          if (event.status.state === "ended" && event.status.saved)
            void request("bootstrap", {})
              .then(setData)
              .catch(() => undefined);
          return;
        }
        if (event.type !== "boost") return;
        const s = event.session;
        setData((old) =>
          old
            ? {
                ...old,
                boost: {
                  ...old.boost,
                  session: s.status === "ended" ? null : s,
                },
              }
            : old,
        );
        // A finished session also wrote activity rows and may have changed saved state.
        if (s.status === "ended" || s.status === "recovery-needed")
          void request("bootstrap", {})
            .then(setData)
            .catch(() => undefined);
      }),
    [],
  );
  useEffect(() => {
    document.documentElement.dataset.theme =
      data?.state.settings.theme ?? "dark";
  }, [data?.state.settings.theme]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(
      () => setNotice(null),
      notice.error ? 12000 : 5000,
    );
    return () => clearTimeout(timer);
  }, [notice]);
  async function run<M extends Method>(
    method: M,
    input: Request<M>,
    message?: string,
  ): Promise<Response<M> | undefined> {
    // The timer prompt can stay open for minutes; it gets its own counter so only that control waits.
    const setCount =
      method === "boostTimerGlobal"
        ? setTimerRequests
        : elevatedMethods.has(method)
          ? setRestoreRequests
          : setRequestsPending;
    setCount((n) => n + 1);
    try {
      const output = await request(method, input);
      const fresh = await request("bootstrap", {});
      setData(
        method === "refresh"
          ? { ...fresh, hardware: output as Bootstrap["hardware"] }
          : fresh,
      );
      if (message && fresh.state.settings.notifications)
        setNotice({ text: message, error: false });
      // The page that asked may be gone by the time the administrator prompt is answered.
      const declined = output as { cancelled?: boolean; outcome?: string };
      if (
        elevatedMethods.has(method) &&
        (declined.cancelled || declined.outcome === "elevation-cancelled")
      )
        setNotice({
          text: "Administrator approval was declined. Nothing was changed.",
          error: false,
        });
      return output;
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : "The request failed. Retry the action.";
      setNotice({
        text:
          elevatedMethods.has(method) && message.includes("timed out")
            ? "Windows did not get an administrator answer in time. Nothing was changed; try again when you can approve the prompt."
            : message,
        error: true,
      });
      return undefined;
    } finally {
      setCount((n) => n - 1);
    }
  }
  function navigate(next: Page) {
    if (next !== page)
      void request("trackUsage", { event: "feature_opened", page: next }).catch(
        () => undefined,
      );
    setPage(next);
    setMobile(false);
    window.scrollTo({ top: 0 });
  }
  const flow = useApplyFlow({
    data,
    run,
    notify: (text, error) => setNotice({ text, error }),
  });
  if (!data)
    return (
      <div className="startup">
        <Flame size={36} />
        <h1>Frameforge</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button onClick={() => void load()}>
              <RefreshCw size={17} />
              Retry
            </Button>
          </>
        ) : (
          <Busy label="Reading local configuration" />
        )}
      </div>
    );
  const props: ViewProps = {
    data,
    pending: requestsPending > 0,
    restorePending: restoreRequests > 0,
    timerPending: timerRequests > 0,
    run,
    navigate,
    preview: (ids) => void flow.open(ids),
    scan,
  };
  const views: Record<Page, React.ReactNode> = {
    Dashboard: <Dashboard {...props} />,
    Optimizations: <Optimizations {...props} />,
    Presets: <Presets {...props} />,
    "Game library": <Games {...props} />,
    "Game Mode": <GameMode {...props} />,
    "Restore & backups": <Backups {...props} />,
    System: <System {...props} />,
    Monitor: <Monitor {...props} />,
    "Health Check": <HealthCheck {...props} />,
    Activity: <ActivityLog {...props} />,
    Settings: <Settings {...props} />,
  };
  const recoveryRows = data.activity.filter(
    (a) => a.status === "recovery-needed",
  );
  const boostRecovery = data.boost.session?.status === "recovery-needed";
  const recovery = recoveryRows.length + (boostRecovery ? 1 : 0);
  // Restore point rows are resolved on Restore & backups; a booster session on Game Mode (Retry / Dismiss).
  const recoveryPage: Page = recoveryRows.length
    ? recoveryRows.every(restoreRecoveryRow)
      ? "Restore & backups"
      : "Activity"
    : "Game Mode";
  const memoryUsed = data.hardware.memoryBytes
    ? Math.round(
        ((data.hardware.memoryBytes - data.hardware.freeMemoryBytes) /
          data.hardware.memoryBytes) *
          100,
      )
    : 0;
  const status =
    recovery > 0
      ? { text: "Recovery needed", tone: "error" as const }
      : data.boost.session
        ? { text: "Boost engaged", tone: "caution" as const }
        : { text: "System state: nominal", tone: "ok" as const };
  const items = navigation.map((n) => ({
    ...n,
    badge:
      n.page === "Activity" && recoveryRows.length > 0 ? (
        <Badge tone="red">{recoveryRows.length}</Badge>
      ) : n.page === "Game Mode" && boostRecovery ? (
        <Badge tone="red">1</Badge>
      ) : undefined,
  }));
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <NavRail
        items={items}
        current={page}
        onNavigate={navigate}
        open={mobile}
        onClose={() => setMobile(false)}
        bottomItem={settingsItem}
        version={data.version}
        footer={
          <div className="rail-chassis">
            <div>
              <span className="label">Local by design</span>
              <strong>Private by default. No account.</strong>
            </div>
            <span className={`led ${data.mode === "demo" ? "warn" : ""}`} />
          </div>
        }
      />
      {mobile && (
        <button
          aria-label="Close navigation"
          className="nav-scrim"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="workspace">
        <TopBar
          onMenu={() => setMobile(true)}
          status={status}
          readouts={[
            { label: "Memory", value: `${memoryUsed}%` },
            { label: "Cores", value: String(data.hardware.cores) },
          ]}
        >
          {requestsPending > 0 && <Busy label="Working" />}
          <Badge tone={data.mode === "demo" ? "amber" : "lime"}>
            {data.mode === "demo" ? "Demo data" : "On this PC"}
          </Badge>
          <button
            className="icon-button"
            title="Refresh system readings"
            aria-label="Refresh system readings"
            disabled={requestsPending > 0}
            onClick={() =>
              void run("refresh", {}, "System readings refreshed.")
            }
          >
            <RefreshCw size={17} />
          </button>
        </TopBar>
        {recovery > 0 && (
          <button
            className="recovery-banner"
            onClick={() => navigate(recoveryPage)}
          >
            <AlertTriangle size={18} />
            {recovery} operation{recovery === 1 ? "" : "s"} need recovery.
            {recoveryPage === "Activity"
              ? " Review saved snapshots."
              : recoveryPage === "Game Mode"
                ? " Open Game Mode to retry or dismiss."
                : " Open Restore & backups."}
            <ChevronRight size={17} />
          </button>
        )}
        <UpdateCard />
        <main id="main-content" tabIndex={-1}>
          <PageTransition pageKey={page}>
            <Suspense fallback={<Busy label="Loading" />}>
              {views[page]}
            </Suspense>
          </PageTransition>
        </main>
        <footer>
          <span>FRAMEFORGE</span>
          <span>
            {data.mode === "demo"
              ? "Browser preview / Windows operations disabled"
              : "Offline-ready / Windows changes are previewed and recorded"}
          </span>
          <span>v{data.version}</span>
        </footer>
      </div>
      {notice && (
        <Toast
          text={notice.text}
          error={notice.error}
          onDismiss={() => setNotice(null)}
        />
      )}
      <ApplyFlowDialog
        flow={flow}
        run={run}
        pending={requestsPending > 0}
        restoreRequests={restoreRequests}
        navigate={navigate}
      />
    </div>
  );
}
