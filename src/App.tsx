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
import { request } from "./api";
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
import { Button, Modal, Badge, Busy, formatTime } from "./components/ui";
import { Dashboard } from "./views/Dashboard";
import { Optimizations, Presets } from "./views/Optimizations";
import { Games, GameMode } from "./views/Games";
import { Backups, ActivityLog } from "./views/Recovery";
import { System, Settings } from "./views/System";
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
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [selection, setSelection] = useState<OperationId[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<Activity | null>(null);
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
    setRequestsPending((n) => n + 1);
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
      return output;
    } catch (e) {
      setNotice({
        text:
          e instanceof Error
            ? e.message
            : "The request failed. Retry the action.",
        error: true,
      });
      return undefined;
    } finally {
      setRequestsPending((n) => n - 1);
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
    setResult(null);
    setConfirmed(false);
    if (!data || ids.some((id) => !data.capabilities.includes(id))) return;
    setPreviewLoading(true);
    try {
      setPreview(await request("preview", { ids }));
    } catch (e) {
      setNotice({
        text: e instanceof Error ? e.message : "Preview failed.",
        error: true,
      });
    } finally {
      setPreviewLoading(false);
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
  const props: ViewProps = {
    data,
    pending: requestsPending > 0,
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
  const recovery = data.activity.filter(
    (a) => a.status === "recovery-needed",
  ).length;
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
              {n.name === "Activity" && recovery > 0 && (
                <Badge tone="red">{recovery}</Badge>
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
            onClick={() => navigate("Activity")}
          >
            <AlertTriangle size={18} />
            {recovery} operation{recovery === 1 ? "" : "s"} need recovery.
            Review saved snapshots.
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
              : "Offline-ready / Current-user operations only"}
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
                      <Badge tone={item.risk === "Low" ? "lime" : "amber"}>
                        {item.risk} risk
                      </Badge>
                      <p className="muted">{item.description}</p>
                    </div>
                  );
                })}
              </div>
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
                    Preview expires {formatTime(preview.expiresAt)}. No
                    elevation or restart required.
                  </p>
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
                <div className="notice">
                  <AlertTriangle size={18} />
                  These Windows changes are unavailable on this installation.
                  This is a review only. Launch the desktop app with its
                  published Windows helper to check prerequisites.
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
                    !preview || !confirmed || applying || previewLoading
                  }
                  onClick={async () => {
                    if (!preview) return;
                    setApplying(true);
                    const output = await run("confirm", {
                      token: preview.token,
                      confirmed: true,
                    });
                    setApplying(false);
                    if (output) setResult(output);
                    else {
                      setPreview(null);
                      setConfirmed(false);
                    }
                  }}
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
