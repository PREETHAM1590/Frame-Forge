import { useState } from "react";
import {
  Archive,
  Plus,
  RotateCcw,
  ArrowUpRight,
  AlertTriangle,
  Trash2,
  History,
} from "lucide-react";
import {
  PageTitle,
  Button,
  Badge,
  Empty,
  Modal,
  formatTime,
} from "../components/ui";
import type { Backup, Activity } from "../../shared/contracts";
import type { ViewProps } from "../types";
export function Backups({ data, run, pending }: ViewProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Backup | null>(null);
  return (
    <>
      <PageTitle
        title="Restore & backups"
        subtitle="Save your app configuration. Keep Windows recovery separate."
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={17} />
            Create backup
          </Button>
        }
      />
      <div className="notice">
        <Archive size={19} />
        These are app configuration backups, not Windows System Restore points.
        Windows preferences are restored from their operation snapshots in
        Activity.
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
export function ActivityLog({ data, run, pending }: ViewProps) {
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
                  <Badge
                    tone={
                      a.status === "success"
                        ? "lime"
                        : a.status === "recovery-needed"
                          ? "red"
                          : "neutral"
                    }
                  >
                    {a.status}
                  </Badge>
                </div>
                <p className="muted">{a.message}</p>
                <span className="muted">{formatTime(a.at)}</span>
              </div>
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
          description="Restore the exact current-user registry values captured before this operation. A conflicting external change will stop rollback."
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
