import * as Switch from "@radix-ui/react-switch";
import { RefreshCw, ShieldAlert, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { request } from "../api";
import {
  Badge,
  Busy,
  Button,
  Chips,
  Disclosure,
  Empty,
  ErrorState,
  Modal,
  PageTitle,
  Panel,
  SearchField,
  formatTime,
} from "../components/ui";
import type { StartupItem, StartupStatus } from "../../shared/contracts";
import type { ViewProps } from "../types";

/** MB or KB: startup programs are small, the shared formatter is GB-sized. */
const size = (bytes: number) =>
  bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
type Filter = "all" | "enabled" | "disabled";
export const sourceLabels: Record<StartupItem["source"], string> = {
  "hkcu-run": "Registry Run (you)",
  "hklm-run": "Registry Run (all users)",
  "hklm-run32": "Registry Run, 32-bit (all users)",
  "hkcu-folder": "Startup folder (you)",
  "hklm-folder": "Startup folder (all users)",
  "hkcu-runonce": "RunOnce (you)",
  "hklm-runonce": "RunOnce (all users)",
  task: "Task Scheduler logon task",
  uwp: "Microsoft Store app",
};
const impactTone = {
  low: "lime",
  medium: "amber",
  high: "red",
  unknown: "neutral",
} as const;
/** Pure filter used by the page and its tests. */
export function filterItems(
  items: StartupItem[],
  filter: Filter,
  query: string,
): StartupItem[] {
  const q = query.trim().toLowerCase();
  return items.filter(
    (i) =>
      (filter === "all" ||
        (filter === "enabled" ? i.enabled === true : i.enabled === false)) &&
      (!q ||
        [i.name, i.publisher, i.path, i.command, sourceLabels[i.source]].some(
          (text) => text.toLowerCase().includes(q),
        )),
  );
}

export function Startup({ run, data }: ViewProps) {
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<StartupItem | null>(null);
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : "Could not read startup apps.");
  const load = () => {
    setError("");
    return request("startupList", {}).then(setStatus, fail);
  };
  useEffect(() => {
    let active = true;
    void request("startupList", {}).then(
      (value) => active && setStatus(value),
      (e) => active && fail(e),
    );
    return () => {
      active = false;
    };
  }, []);
  const change = async (
    key: string,
    work: () => Promise<StartupStatus | undefined>,
  ) => {
    setBusy(key);
    try {
      const next = await work();
      if (next) setStatus(next);
    } finally {
      setBusy(null);
    }
  };
  const toggle = (item: StartupItem, enabled: boolean, acknowledged = false) =>
    change(item.id, () =>
      run(
        "startupSet",
        {
          id: item.id,
          enabled,
          ...(acknowledged ? { acknowledged: true as const } : {}),
        },
        `${item.name} ${enabled ? "enabled" : "disabled"}.`,
      ),
    );
  const shown = useMemo(
    () => filterItems(status?.items ?? [], filter, query),
    [status, filter, query],
  );
  const undoable = new Set(status?.changes.map((c) => c.id));
  // What you can switch off comes first, biggest estimated impact on top.
  const impactRank = { high: 0, medium: 1, low: 2, unknown: 3 } as const;
  const switchable = shown
    .filter((i) => i.canToggle)
    .sort(
      (x, y) =>
        Number(y.enabled === true) - Number(x.enabled === true) ||
        impactRank[x.impact] - impactRank[y.impact],
    );
  const listed = shown.filter((i) => !i.canToggle);
  const row = (item: StartupItem) => (
    <li
      key={item.id}
      className={`startup-row ${item.enabled === false ? "off" : ""}`}
    >
      <div className="startup-main">
        <strong>{item.name}</strong>
        <span className="muted">
          {item.publisher || "Publisher unknown"} · {sourceLabels[item.source]}
        </span>
        <code className="startup-path" title={item.command}>
          {item.path || item.command}
        </code>
        {item.note && <span className="muted">{item.note}</span>}
      </div>
      <div className="startup-meta">
        {item.critical && (
          <span title={item.criticalReason ?? undefined}>
            <Badge tone="amber">
              <ShieldAlert size={13} /> Protected
            </Badge>
          </span>
        )}
        <span title="Estimated from the program's file size. Windows' own startup impact is not available to Frameforge.">
          <Badge tone={impactTone[item.impact]}>
            Est. impact: {item.impact}
            {item.sizeBytes !== null ? ` · ${size(item.sizeBytes)}` : ""}
          </Badge>
        </span>
        {item.scope === "machine" && item.canToggle && (
          <Badge>Needs admin</Badge>
        )}
      </div>
      <div className="startup-actions">
        {undoable.has(item.id) && (
          <Button
            disabled={busy !== null}
            aria-label={`Undo change to ${item.name}`}
            onClick={() =>
              void change(item.id, () =>
                run("startupUndo", { id: item.id }, `${item.name} restored.`),
              )
            }
          >
            <Undo2 size={15} /> Undo
          </Button>
        )}
        {item.canToggle ? (
          <Switch.Root
            className="switch"
            aria-label={`${item.name} starts with Windows`}
            checked={item.enabled === true}
            disabled={busy !== null}
            onCheckedChange={(on) =>
              !on && item.critical ? setConfirm(item) : void toggle(item, on)
            }
          >
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
        ) : (
          <Badge>
            Listed only
            {item.enabled === null ? "" : item.enabled ? " · on" : " · off"}
          </Badge>
        )}
      </div>
    </li>
  );
  const count = (f: Filter) => filterItems(status?.items ?? [], f, "").length;
  const history = data.activity
    .filter((a) => a.label.startsWith("Startup "))
    .slice(0, 5);
  return (
    <>
      <PageTitle
        title="Startup apps"
        subtitle="Programs that start when you sign in. Switching one off here is the same switch Task Manager uses. Nothing is deleted."
        action={
          <Button
            disabled={busy !== null}
            onClick={() => void load()}
            aria-label="Rescan startup apps"
          >
            <RefreshCw size={17} /> Rescan
          </Button>
        }
      />
      {error ? (
        <ErrorState
          title="Startup apps unavailable"
          message={error}
          onRetry={() => void load()}
        />
      ) : !status ? (
        <Busy label="Reading startup apps" />
      ) : (
        <>
          <div className="toolbar">
            <SearchField
              label="Search startup apps"
              placeholder="Search name, publisher or path"
              value={query}
              onChange={setQuery}
            />
            <Chips
              label="Filter by state"
              value={filter}
              onChange={setFilter}
              options={[
                { id: "all", label: "All", count: count("all") },
                { id: "enabled", label: "Enabled", count: count("enabled") },
                { id: "disabled", label: "Disabled", count: count("disabled") },
              ]}
            />
          </div>
          {status.warnings.map((w) => (
            <p key={w} className="muted" role="status">
              {w}
            </p>
          ))}
          {shown.length === 0 ? (
            <Empty
              title={status.items.length ? "No match" : "No startup apps found"}
              description={
                status.items.length
                  ? "Change the search or the filter."
                  : "Windows reports nothing that starts at sign-in."
              }
            />
          ) : (
            <>
              <ul className="startup-list" aria-label="Startup apps">
                {switchable.map(row)}
              </ul>
              {listed.length > 0 && (
                <Disclosure
                  title={`Can't be switched from here (${listed.length})`}
                  hint="Use Task Manager"
                >
                  <p className="muted">
                    Frameforge can only read these. Change them in Task Manager
                    or Settings &gt; Apps &gt; Startup.
                  </p>
                  <ul
                    className="startup-list"
                    aria-label="Startup apps that cannot be switched here"
                  >
                    {listed.map(row)}
                  </ul>
                </Disclosure>
              )}
            </>
          )}
          {busy && <Busy label="Applying change" />}
          <Panel>
            <h2>Recent startup changes</h2>
            {history.length === 0 ? (
              <p className="muted">Nothing changed yet.</p>
            ) : (
              <ul className="startup-history">
                {history.map((a) => (
                  <li key={a.id}>
                    <Badge tone={a.status === "success" ? "lime" : "amber"}>
                      {a.label}
                    </Badge>{" "}
                    {a.message}{" "}
                    <span className="muted">{formatTime(a.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
      {confirm && (
        <Modal
          title={`Turn off ${confirm.name}?`}
          description={confirm.criticalReason ?? "This item is protected."}
          onClose={() => setConfirm(null)}
        >
          <p>
            This is a warning, not a block. You can switch it back on at any
            time, here or in Task Manager.
          </p>
          <div className="toolbar">
            <Button onClick={() => setConfirm(null)}>Keep it on</Button>
            <Button
              variant="danger"
              onClick={() => {
                const item = confirm;
                setConfirm(null);
                void toggle(item, false, true);
              }}
            >
              Turn off anyway
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
