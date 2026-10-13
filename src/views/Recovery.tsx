import { useEffect, useState } from "react";
import {
  Archive,
  Plus,
  RotateCcw,
  ArrowUpRight,
  AlertTriangle,
  Trash2,
  History,
  ShieldCheck,
  Info,
} from "lucide-react";
import {
  PageTitle,
  Button,
  Busy,
  Badge,
  Empty,
  Modal,
  formatTime,
  statusTone,
} from "../components/ui";
import {
  RestoreDescription,
  type Backup,
  type Activity,
  type CreateRestorePointResult,
  type RestorePoints,
  type RestoreStatus,
} from "../../shared/contracts";
import { request } from "../api";
import type { ViewProps } from "../types";
const dayMs = 24 * 60 * 60 * 1000;
/** One honest wording for System Protection, shared by Dashboard and Restore & backups. */
export function protectionChip(
  status: RestoreStatus | null,
  mode: ViewProps["data"]["mode"],
): { text: string; tone: "lime" | "red" | "neutral" | "amber" } {
  if (mode === "demo") return { text: "Desktop app only", tone: "neutral" };
  if (!status) return { text: "Checking protection", tone: "neutral" };
  if (status.policyDisabled) return { text: "Blocked by policy", tone: "red" };
  const drive = status.systemDrive;
  if (status.protection === "enabled")
    return status.systemDriveConfirmedAt
      ? {
          text: `Protection on; ${drive} confirmed ${formatTime(status.systemDriveConfirmedAt)}`,
          tone: "lime",
        }
      : {
          text: `Protection on for a drive (${drive} unconfirmed)`,
          tone: "amber",
        };
  if (status.protection === "disabled")
    return { text: "Protection off", tone: "red" };
  return { text: "Protection state unknown", tone: "neutral" };
}
type ElevatedAction = "list" | "open" | "recover" | "anyway";
// What each elevating action tells the user before Windows shows its administrator prompt.
const elevationCopy: Record<
  ElevatedAction,
  { title: string; why: string; go: string }
> = {
  list: {
    title: "Load restore points?",
    why: "Windows only lets administrators list restore points. Windows will show an administrator prompt (UAC). Approve it to see the list, or decline and nothing changes.",
    go: "Continue to administrator prompt",
  },
  open: {
    title: "Open Windows System Restore?",
    why: "Windows System Restore runs as administrator. Windows will show an administrator prompt before it opens. Frameforge does not restore anything itself.",
    go: "Continue to administrator prompt",
  },
  recover: {
    title: "Restore the original restore point limit?",
    why: "Changing the Windows restore point limit needs administrator rights. Windows will show an administrator prompt (UAC). Decline it and the limit stays as it is.",
    go: "Continue to administrator prompt",
  },
  anyway: {
    title: "Create a restore point anyway?",
    why: "This temporarily lifts the Windows once-per-day restore point limit, creates the point, then puts the limit back. Windows will show an administrator prompt (UAC) and creating the point can take a few minutes.",
    go: "Continue to administrator prompt",
  },
};
function WindowsRestore({ data, run, pending, restorePending }: ViewProps) {
  const [confirm, setConfirm] = useState<ElevatedAction | null>(null);
  // Only restore actions wait on the administrator prompt; the rest of the app stays usable.
  const locked = pending || restorePending;
  const [status, setStatus] = useState<RestoreStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [lastName, setLastName] = useState("");
  const [result, setResult] = useState<CreateRestorePointResult | null>(null);
  const [points, setPoints] = useState<RestorePoints | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [recent, setRecent] = useState<string | null>(null);
  async function refresh() {
    try {
      setStatus(await request("restoreStatus", {}));
      setStatusError("");
    } catch (e) {
      setStatusError(
        e instanceof Error ? e.message : "System Restore status unavailable.",
      );
    }
  }
  useEffect(() => {
    let active = true;
    void request("restoreStatus", {})
      .then((value) => active && setStatus(value))
      .catch(
        (e) =>
          active &&
          setStatusError(
            e instanceof Error
              ? e.message
              : "System Restore status unavailable.",
          ),
      );
    return () => {
      active = false;
    };
  }, []);
  const blocked =
    data.mode === "demo"
      ? "Windows System Restore requires the desktop app."
      : status?.policyDisabled
        ? status.message
        : null;
  const drive = status?.systemDrive ?? "C:";
  function openNameDialog() {
    const last = status?.lastAppCreatedAt;
    setRecent(last && Date.now() - Date.parse(last) < dayMs ? last : null);
    setName(`Frameforge ${new Date().toLocaleDateString("en-CA")}`);
  }
  async function create(description: string, bypassThrottle: boolean) {
    setLastName(description);
    const output = await run("createRestorePoint", {
      name: description,
      confirmed: true,
      bypassThrottle,
    });
    if (output) setResult(output);
    await refresh();
  }
  // The Windows administrator prompt appears only after the user confirmed in the dialog above.
  async function elevate(action: ElevatedAction) {
    if (action === "list") {
      const output = await run("restorePoints", {});
      if (output) setPoints(output);
      await refresh();
    } else if (action === "open") {
      setOpenFailed((await run("openSystemRestore", {})) === false);
    } else if (action === "recover") {
      const output = await run(
        "recoverRestoreFrequency",
        { confirmed: true },
        "Restore point frequency checked.",
      );
      if (output) setStatus(output);
    } else await create(lastName, true);
  }
  const validName = name !== null && RestoreDescription.safeParse(name).success;
  return (
    <section className="settings-section">
      <h2>
        <ShieldCheck size={19} />
        Windows System Restore (whole-PC recovery)
      </h2>
      <div className="restore-status">
        {status ? (
          <>
            <Badge tone={protectionChip(status, data.mode).tone}>
              {protectionChip(status, data.mode).text}
            </Badge>
            <span className="muted">{status.message}</span>
          </>
        ) : (
          <span className="muted">
            {statusError || "Reading System Restore status"}
          </span>
        )}
      </div>
      {status?.pendingFrequencyRecovery && (
        <div className="notice" role="alert">
          <AlertTriangle size={18} />
          <div>
            A temporary change to the Windows restore point limit was not
            confirmed as undone.
            <div className="restore-actions">
              <Button disabled={locked} onClick={() => setConfirm("recover")}>
                <RotateCcw size={16} />
                Restore the original limit
              </Button>
            </div>
          </div>
        </div>
      )}
      {status?.pendingCreation && (
        <div className="notice" role="status">
          <Info size={18} />
          <div>
            Windows may still be creating a restore point requested earlier.
            Check again, or use Load restore points to verify it.
            <div className="restore-actions">
              <Button disabled={locked} onClick={() => void refresh()}>
                <RotateCcw size={16} />
                Check again
              </Button>
            </div>
          </div>
        </div>
      )}
      <div className="restore-actions">
        <Button
          variant="primary"
          aria-describedby={blocked ? "restore-blocked" : undefined}
          disabled={locked || !!blocked || !status}
          onClick={openNameDialog}
        >
          <Plus size={17} />
          Create restore point
        </Button>
        <Button
          disabled={locked || !!blocked}
          onClick={() => setConfirm("list")}
        >
          Load restore points
        </Button>
        <Button
          disabled={locked || data.mode === "demo"}
          onClick={() => setConfirm("open")}
        >
          <ArrowUpRight size={16} />
          Open Windows System Restore
        </Button>
      </div>
      {restorePending && (
        <div className="notice" role="status">
          <Busy label="Waiting for administrator approval…" />
          <span>
            Approve or decline the Windows prompt. Nothing else in Frameforge is
            blocked while you decide.
          </span>
        </div>
      )}
      {blocked && (
        <p className="muted" id="restore-blocked">
          {blocked}
        </p>
      )}
      {openFailed && (
        <p className="muted">Windows System Restore could not be opened.</p>
      )}
      {result && (
        <div className="notice" role="status">
          {result.outcome === "created" ||
          result.outcome === "pending" ||
          result.outcome === "elevation-cancelled" ? (
            <Info size={18} />
          ) : (
            <AlertTriangle size={18} />
          )}
          <div>
            {result.message}
            {result.outcome === "throttled" && (
              <div className="restore-actions">
                <Button
                  variant="danger"
                  disabled={locked}
                  onClick={() => setConfirm("anyway")}
                >
                  Create anyway (temporarily lifts the limit, then restores it)
                </Button>
              </div>
            )}
            {(result.outcome === "protection-disabled" ||
              result.outcome === "failed") && (
              <div className="restore-actions">
                <Button
                  disabled={locked || !!status?.configLocked}
                  aria-describedby={
                    status?.configLocked ? "enable-locked" : undefined
                  }
                  onClick={() => setEnabling(true)}
                >
                  Turn on System Protection for {drive}
                </Button>
                {status?.configLocked && (
                  <p className="muted" id="enable-locked">
                    Turning on System Protection is blocked by policy on this
                    PC. Restore points can still be created.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {points?.cancelled ? (
        <div className="notice" role="status">
          <Info size={18} />
          {points.message}
        </div>
      ) : (
        points &&
        (points.available && points.points.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sequence</th>
                  <th>Description</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {points.points.map((p) => (
                  <tr key={p.sequence}>
                    <td>{p.sequence}</td>
                    <td>{p.description}</td>
                    <td>{formatTime(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{points.message}</p>
        ))
      )}
      {confirm && (
        <Modal
          title={elevationCopy[confirm].title}
          description={elevationCopy[confirm].why}
          onClose={() => setConfirm(null)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={locked}
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                void elevate(action);
              }}
            >
              {elevationCopy[confirm].go}
            </Button>
          </div>
        </Modal>
      )}
      {name !== null && (
        <Modal
          title="Create Windows restore point"
          description="Windows will show an administrator prompt. Creating a restore point can take a few minutes."
          onClose={() => setName(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const description = name.trim();
              setName(null);
              void create(description, false);
            }}
          >
            <label className="field">
              Restore point name
              <input
                autoFocus
                required
                maxLength={64}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {!validName && (
              <p className="muted">
                Use up to 64 letters, numbers, spaces, dots, underscores,
                brackets or hyphens.
              </p>
            )}
            {recent && (
              <div className="notice">
                <AlertTriangle size={18} />
                Frameforge created a restore point at {formatTime(recent)}.
                Windows usually skips another one within 24 hours.
              </div>
            )}
            <div className="dialog-actions">
              <Button type="button" onClick={() => setName(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={locked || !validName}
              >
                Create restore point
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {enabling && (
        <Modal
          title={`Turn on System Protection for ${drive}?`}
          description={`Windows reserves part of ${drive} for restore points (usually a few percent of the drive) and deletes the oldest points when that space fills. Windows will show an administrator prompt.`}
          onClose={() => setEnabling(false)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setEnabling(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={locked}
              onClick={async () => {
                setEnabling(false);
                const output = await run("enableSystemProtection", {
                  confirmed: true,
                });
                if (output) {
                  setStatus(output);
                  setResult(null);
                }
              }}
            >
              Turn on System Protection
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
export function Backups(props: ViewProps) {
  const { data, run, pending } = props;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Backup | null>(null);
  return (
    <>
      <PageTitle
        title="Restore & backups"
        subtitle="Windows whole-PC recovery and Frameforge configuration backups, kept separate."
      />
      <WindowsRestore {...props} />
      <section className="settings-section">
        <h2>
          <Archive size={19} />
          App configuration backups
        </h2>
        <div className="restore-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={17} />
            Create backup
          </Button>
        </div>
      </section>
      <div className="notice">
        <Archive size={19} />
        These are app configuration backups, not Windows System Restore points.
        They only cover Frameforge settings. Windows preferences are restored
        from their operation snapshots in Activity.
      </div>
      {data.backups.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Backup</th>
                <th>Created</th>
                <th>Contents</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.backups.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.name}</strong>
                    <p className="muted">Configuration v{b.state.version}</p>
                  </td>
                  <td>{formatTime(b.at)}</td>
                  <td>
                    {b.state.games.length} games / {b.state.presets.length}{" "}
                    presets
                  </td>
                  <td>
                    <Button onClick={() => setSelected(b)}>
                      Inspect
                      <ArrowUpRight size={16} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="No configuration backups yet"
          description="A named backup saves your app settings, game profiles and custom presets."
        />
      )}
      {creating && (
        <Modal
          title="Create configuration backup"
          description="Only Frameforge app configuration is saved. Windows settings are not included."
          onClose={() => setCreating(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await run("backup", { name }, "Configuration backup created.")
              ) {
                setCreating(false);
                setName("");
              }
            }}
          >
            <label className="field">
              Backup name
              <input
                autoFocus
                required
                maxLength={80}
                placeholder="Before my next session"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <Button type="button" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={pending || !name.trim()}
              >
                Create backup
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {selected && (
        <Modal
          title={selected.name}
          description={`Saved ${formatTime(selected.at)}. Restoring replaces the current app configuration and first creates a safety backup.`}
          onClose={() => setSelected(null)}
        >
          <div className="details-grid">
            <span>
              Theme<strong>{selected.state.settings.theme}</strong>
            </span>
            <span>
              Startup
              <strong>
                {selected.state.settings.startup ? "Enabled" : "Disabled"}
              </strong>
            </span>
            <span>
              Games<strong>{selected.state.games.length}</strong>
            </span>
            <span>
              Custom presets<strong>{selected.state.presets.length}</strong>
            </span>
          </div>
          <h3>Saved games</h3>
          <p className="muted">
            {selected.state.games.map((g) => g.name).join(", ") ||
              "No saved games"}
          </p>
          <h3>Saved presets</h3>
          <p className="muted">
            {selected.state.presets.map((p) => p.name).join(", ") ||
              "No custom presets"}
          </p>
          <div className="notice">
            <AlertTriangle size={18} />
            Windows registry values and game files will not be restored. App
            startup preference will be restored.
          </div>
          <div className="dialog-actions">
            <Button onClick={() => setSelected(null)}>Close</Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={async () => {
                if (
                  await run(
                    "restore",
                    { id: selected.id, confirmed: true },
                    "App configuration restored.",
                  )
                )
                  setSelected(null);
              }}
            >
              <RotateCcw size={17} />
              Confirm restore
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
/** Restore point journal rows are resolved on Restore & backups, not by a registry rollback. */
export const restoreRecoveryRow = (a: Activity) =>
  !a.rollback &&
  a.label.startsWith("Restore point") &&
  (a.status === "running" || a.status === "recovery-needed");
export function ActivityLog({ data, run, pending, navigate }: ViewProps) {
  const [selected, setSelected] = useState<Activity | null>(null);
  const [filter, setFilter] = useState("All");
  const [clear, setClear] = useState(false);
  const list = data.activity.filter(
    (a) => filter === "All" || a.status === filter,
  );
  return (
    <>
      <PageTitle
        title="Activity"
        subtitle="Local operations, their results, and a way to recover."
        action={
          <Button onClick={() => setClear(true)} disabled={pending}>
            <Trash2 size={16} />
            Clear completed logs
          </Button>
        }
      />
      <div className="toolbar">
        <span className="muted">{list.length} operations</span>
        <select
          aria-label="Activity status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {[
            "All",
            "success",
            "failed",
            "cancelled",
            "rolled-back",
            "recovery-needed",
            "running",
          ].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </div>
      {list.length ? (
        <div className="activity-list">
          {list.map((a) => (
            <article key={a.id}>
              <span
                className={`action-icon ${a.status === "recovery-needed" ? "red" : "cyan"}`}
              >
                <History size={21} />
              </span>
              <div>
                <div className="inline-title">
                  <h3>{a.label}</h3>
                  <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                </div>
                <p className="muted">{a.message}</p>
                <span className="muted">{formatTime(a.at)}</span>
              </div>
              {restoreRecoveryRow(a) && (
                <Button onClick={() => navigate("Restore & backups")}>
                  <ArrowUpRight size={16} />
                  Open Restore & backups
                </Button>
              )}
              {a.rollback && (
                <Button disabled={pending} onClick={() => setSelected(a)}>
                  <RotateCcw size={16} />
                  Review rollback
                </Button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="No activity to show"
          description="Configuration changes and Windows operation results are recorded here."
        />
      )}
      {selected && (
        <Modal
          title="Restore Windows snapshot?"
          description="Restore the exact Windows values (registry preferences or power plan) captured before this operation. A conflicting external change will stop rollback."
          onClose={() => setSelected(null)}
        >
          <p>{selected.label}</p>
          <code className="setting-path">Operation ID: {selected.id}</code>
          <p className="muted">{selected.ids.join(", ")}</p>
          <div className="notice">
            <AlertTriangle size={18} />
            Windows may need a new sign-in or the capture app to reopen before
            the restored preference takes effect.
          </div>
          <div className="dialog-actions">
            <Button onClick={() => setSelected(null)}>Cancel</Button>
            <Button
              disabled={pending}
              variant="primary"
              onClick={async () => {
                const result = await run("rollback", {
                  id: selected.id,
                  confirmed: true,
                });
                if (result) setSelected(null);
              }}
            >
              <RotateCcw size={17} />
              Confirm rollback
            </Button>
          </div>
        </Modal>
      )}
      {clear && (
        <Modal
          title="Clear completed logs?"
          description="Only entries without rollback snapshots are removed. Recovery records and restorable operations are retained."
          onClose={() => setClear(false)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setClear(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={async () => {
                if (
                  await run(
                    "clearActivity",
                    { confirmed: true },
                    "Completed logs cleared.",
                  )
                )
                  setClear(false);
              }}
            >
              Confirm clear
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
