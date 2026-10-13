import { useState, useEffect, useCallback } from "react";
import {
  LayoutDashboard,
  SlidersHorizontal,
  Layers,
  Gamepad2,
  Play,
  Archive,
  Cpu,
  History,
  Settings as SettingsIcon,
  Flame,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
  Menu,
  X,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { onEvent, request } from "./api";
import { catalogue } from "../shared/catalogue";
import type {
  Bootstrap,
  Method,
  Request,
  Response,
  OperationId,
  Preview,
  Activity,
} from "../shared/contracts";
import type { Page, ViewProps } from "./types";
import {
  Button,
  Modal,
  Badge,
  Busy,
  LinkButton,
  formatTime,
} from "./components/ui";
import { Dashboard } from "./views/Dashboard";
import { Optimizations, Presets } from "./views/Optimizations";
import { Games, GameMode } from "./views/Games";
import { Backups, ActivityLog, restoreRecoveryRow } from "./views/Recovery";
import { System, Settings } from "./views/System";
const dayMs = 24 * 60 * 60 * 1000;
// These can sit behind a Windows administrator prompt for minutes, so they must not lock the rest of the app.
const elevatedMethods: ReadonlySet<Method> = new Set([
  "createRestorePoint",
  "restorePoints",
  "enableSystemProtection",
  "recoverRestoreFrequency",
  "openSystemRestore",
]);
const restoreWait =
  "A System Restore request is waiting on Windows. Wait for it to finish before changing Windows settings.";
const changeKey = (changes: Preview["changes"]) =>
  JSON.stringify(changes.map((c) => [c.setting, c.before, c.after]));
const sameChanges = (a: Preview["changes"], b: Preview["changes"]) =>
  changeKey(a) === changeKey(b);
const navigation = [
  { name: "Dashboard", icon: LayoutDashboard },
  { name: "Optimizations", icon: SlidersHorizontal },
  { name: "Presets", icon: Layers },
  { name: "Game library", icon: Gamepad2 },
  { name: "Game Mode", icon: Play },
  { name: "Restore & backups", icon: Archive },
  { name: "System", icon: Cpu },
  { name: "Activity", icon: History },
  { name: "Settings", icon: SettingsIcon },
] as const;
export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState<Page>("Dashboard");
  const [mobile, setMobile] = useState(false);
  const [requestsPending, setRequestsPending] = useState(0);
  const [restoreRequests, setRestoreRequests] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [selection, setSelection] = useState<OperationId[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<Activity | null>(null);
  const [restoreOffer, setRestoreOffer] = useState(false);
  const [createPoint, setCreatePoint] = useState(false);
  const [noPoint, setNoPoint] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Preset items whose prerequisite is missing on this PC (e.g. no performance power plan); the rest still apply.
  const [skipped, setSkipped] = useState<OperationId[]>([]);
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
    const setCount = elevatedMethods.has(method)
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
    setPage(next);
    setMobile(false);
    window.scrollTo({ top: 0 });
  }
  async function openPreview(ids: OperationId[]) {
    setSelection(ids);
    setPreview(null);
    setPreviewError(null);
    setResult(null);
    setConfirmed(false);
    setNoPoint(null);
    setRestoreOffer(false);
    const canSkip = data?.mode === "desktop" && data.capabilities.length > 0;
    const usable = canSkip
      ? ids.filter((id) => data.capabilities.includes(id))
      : ids;
    setSkipped(usable.length ? ids.filter((id) => !usable.includes(id)) : []);
    if (
      !data ||
      !usable.length ||
      usable.some((id) => !data.capabilities.includes(id))
    ) {
      if (data?.mode === "desktop" && data.capabilities.length)
        setPreviewError(
          "A prerequisite is not met on this PC; see Prerequisites in the optimization details.",
        );
      return;
    }
    setPreviewLoading(true);
    try {
      const restore = await request("restoreStatus", {}).catch(() => null);
      const offer =
        !!restore &&
        restore.protection !== "disabled" &&
        !restore.policyDisabled;
      setRestoreOffer(offer);
      setCreatePoint(offer);
      setPreview(await request("preview", { ids: usable }));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setPreviewLoading(false);
    }
  }
  // A restore point can outlast the preview token, so re-preview and only apply unchanged values.
  async function applyChanges(withPoint: boolean, refresh: boolean) {
    if (!preview || !selection) return;
    setApplying(true);
    setNoPoint(null);
    try {
      let token = preview.token;
      if (withPoint) {
        const point = await run("createRestorePoint", {
          name: `Frameforge ${new Date().toLocaleDateString("en-CA")}`,
          confirmed: true,
          bypassThrottle: false,
        });
        const covered =
          point?.outcome === "created" ||
          (point?.outcome === "throttled" &&
            !!point.lastPoint &&
            Date.now() - Date.parse(point.lastPoint.createdAt) < dayMs);
        if (!covered) {
          setNoPoint(point?.message ?? "The restore point was not created.");
          return;
        }
      }
      if (withPoint || refresh) {
        const fresh = await request("preview", {
          ids: selection.filter((id) => !skipped.includes(id)),
        });
        if (!sameChanges(fresh.changes, preview.changes)) {
          setPreview(fresh);
          setConfirmed(false);
          setNotice({
            text: "Windows values changed meanwhile. Review the new preview before applying.",
            error: true,
          });
          return;
        }
        token = fresh.token;
      }
      const output = await run("confirm", { token, confirmed: true });
      if (output) setResult(output);
      else {
        setPreview(null);
        setConfirmed(false);
      }
    } catch (e) {
      setNotice({
        text: e instanceof Error ? e.message : "Preview failed.",
        error: true,
      });
    } finally {
      setApplying(false);
    }
  }
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
  // Explains the skipped preset items and points at the only in-app fix (Game Mode creates the missing plan).
  const skippedNotice = skipped.length ? (
    <p className="notice">
      <AlertTriangle size={17} />
      <span>
        Skipped — not available on this PC:{" "}
        {skipped
          .map((id) => catalogue.find((o) => o.id === id)?.name)
          .join(", ")}
        . The other items in this selection are not affected.{" "}
        {skipped.includes("power-plan") && (
          <LinkButton
            onClick={() => {
              setSelection(null);
              navigate("Game Mode");
            }}
          >
            Create a High performance plan in Game Mode
          </LinkButton>
        )}
      </span>
    </p>
  ) : null;
  const props: ViewProps = {
    data,
    pending: requestsPending > 0,
    restorePending: restoreRequests > 0,
    run,
    navigate,
    preview: (ids) => void openPreview(ids),
  };
  const views: Record<Page, React.ReactNode> = {
    Dashboard: <Dashboard {...props} />,
    Optimizations: <Optimizations {...props} />,
    Presets: <Presets {...props} />,
    "Game library": <Games {...props} />,
    "Game Mode": <GameMode {...props} />,
    "Restore & backups": <Backups {...props} />,
    System: <System {...props} />,
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
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-symbol">
            <Flame size={25} />
          </span>
          <span>
            frameforge<span className="brand-caption">PC CONFIGURATION</span>
          </span>
          <button
            className="icon-button mobile-close"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          >
            <X size={20} />
          </button>
        </div>
        <nav aria-label="Main navigation">
          {navigation.map((n, i) => (
            <button
              key={n.name}
              className={`${page === n.name ? "selected" : ""} ${i === 5 ? "nav-divider" : ""}`}
              aria-current={page === n.name ? "page" : undefined}
              onClick={() => navigate(n.name)}
            >
              <n.icon size={19} />
              <span>{n.name}</span>
              {n.name === "Activity" && recoveryRows.length > 0 && (
                <Badge tone="red">{recoveryRows.length}</Badge>
              )}
              {n.name === "Game Mode" && boostRecovery && (
                <Badge tone="red">1</Badge>
              )}
              {page === n.name && (
                <ChevronRight className="nav-arrow" size={16} />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ShieldCheck size={18} />
          <div>
            <strong>Local by design</strong>
            <span>No telemetry. No account.</span>
          </div>
        </div>
      </aside>
      {mobile && (
        <button
          aria-label="Close navigation"
          className="nav-scrim"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="workspace">
        <div className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-status">
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
          </div>
        </div>
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
        <main id="main-content" tabIndex={-1}>
          {views[page]}
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
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? (
            <AlertTriangle size={19} />
          ) : (
            <CheckCircle2 size={19} />
          )}
          <span>{notice.text}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {selection && (
        <Modal
          title={
            result
              ? "Operation result"
              : selection.length > 1
                ? "Review preset"
                : "Preview Windows preference"
          }
          description={
            result
              ? "The result below comes from the operation journal."
              : "Review the affected settings. Applying creates an app backup and saves the Windows values for rollback."
          }
          locked={applying || previewLoading}
          onClose={() => setSelection(null)}
        >
          {result ? (
            <div className="operation-result">
              <Badge
                tone={
                  result.status === "success"
                    ? "lime"
                    : result.status === "recovery-needed"
                      ? "red"
                      : "amber"
                }
              >
                {result.status}
              </Badge>
              <p>{result.message}</p>
              <code className="setting-path">{result.id}</code>
              {skippedNotice}
              <Button
                onClick={() => {
                  setSelection(null);
                  navigate("Activity");
                }}
              >
                Open activity
                <ChevronRight size={16} />
              </Button>
            </div>
          ) : (
            <>
              <div className="preview-items">
                {selection.map((id) => {
                  const item = catalogue.find((o) => o.id === id)!;
                  return (
                    <div key={id}>
                      <h3>{item.name}</h3>
                      {skipped.includes(id) ? (
                        <Badge tone="amber">
                          Skipped — not available on this PC
                        </Badge>
                      ) : (
                        <Badge tone={item.risk === "Low" ? "lime" : "amber"}>
                          {item.risk} risk
                        </Badge>
                      )}
                      <p className="muted">{item.description}</p>
                    </div>
                  );
                })}
              </div>
              {skippedNotice}
              {previewLoading ? (
                <Busy label="Checking prerequisites and current values" />
              ) : preview ? (
                <>
                  <div className="change-list">
                    {preview.changes.map((change) => (
                      <div key={change.setting}>
                        <code>{change.setting}</code>
                        <span>
                          {change.before}
                          <ChevronRight size={14} />
                          <strong>{change.after}</strong>
                        </span>
                      </div>
                    ))}
                  </div>
                  {preview.warnings.map((w) => (
                    <p className="notice" key={w}>
                      <AlertTriangle size={17} />
                      {w}
                    </p>
                  ))}
                  <p className="muted">
                    Preview expires {formatTime(preview.expiresAt)}.{" "}
                    {restoreOffer && createPoint
                      ? "Creating the restore point shows a Windows administrator prompt."
                      : "No elevation or restart required."}
                  </p>
                  {restoreOffer && (
                    <label className="confirm-check">
                      <input
                        type="checkbox"
                        checked={createPoint}
                        disabled={applying}
                        onChange={(e) => setCreatePoint(e.target.checked)}
                      />
                      Create a Windows restore point first
                    </label>
                  )}
                  {restoreOffer && createPoint && restoreRequests > 0 && (
                    <p className="muted" role="status">
                      Waiting for another Windows restore request to finish
                      (Restore & backups). Untick the restore point to apply
                      now.
                    </p>
                  )}
                  <label className="confirm-check">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={applying}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    I reviewed the changes and confirm applying them.
                  </label>
                </>
              ) : (
                <div
                  className="notice"
                  role={previewError ? "alert" : undefined}
                >
                  <AlertTriangle size={18} />
                  {previewError
                    ? `Preview not available: ${previewError} Nothing was changed.`
                    : "These Windows changes are unavailable on this installation. This is a review only. Launch the desktop app with its published Windows helper to check prerequisites."}
                </div>
              )}
              {noPoint && (
                <div className="notice" role="alert">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>Apply without a restore point?</strong>
                    <p>{noPoint}</p>
                    <div className="dialog-actions">
                      <Button onClick={() => setSelection(null)}>
                        Don&apos;t apply
                      </Button>
                      <Button
                        variant="danger"
                        disabled={applying || restoreRequests > 0}
                        title={restoreRequests > 0 ? restoreWait : undefined}
                        onClick={() => void applyChanges(false, true)}
                      >
                        Apply without a restore point
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              <div className="dialog-actions">
                {applying ? (
                  <Button onClick={() => void run("cancel", {})}>
                    Cancel operation
                  </Button>
                ) : (
                  <Button onClick={() => setSelection(null)}>Close</Button>
                )}
                <Button
                  variant="primary"
                  disabled={
                    !preview ||
                    !confirmed ||
                    applying ||
                    previewLoading ||
                    (restoreOffer && createPoint && restoreRequests > 0) ||
                    restoreRequests > 0
                  }
                  title={restoreRequests > 0 ? restoreWait : undefined}
                  onClick={() =>
                    void applyChanges(restoreOffer && createPoint, false)
                  }
                >
                  {applying ? (
                    <Busy label="Applying and verifying" />
                  ) : (
                    "Confirm & apply"
                  )}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
