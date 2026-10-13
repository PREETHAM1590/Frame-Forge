import { useEffect, useState } from "react";
import {
  Play,
  Cpu,
  MemoryStick,
  HardDrive,
  Monitor,
  ArrowUpRight,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  Gamepad2,
  Archive,
  FolderSearch,
  Activity as ActivityIcon,
} from "lucide-react";
import {
  Badge,
  Button,
  PageTitle,
  formatBytes,
  formatTime,
  Empty,
  LinkButton,
  statusTone,
} from "../components/ui";
import { request } from "../api";
import { GameIcon } from "../components/GameIcon";
import { useScan } from "../useScan";
import { protectionChip } from "./Recovery";
import type { RestoreStatus } from "../../shared/contracts";
import { catalogue, securityIds } from "../../shared/catalogue";
import type { ViewProps } from "../types";
export function Dashboard({
  data,
  navigate,
  preview,
  run,
  pending,
}: ViewProps) {
  const h = data.hardware;
  const { running, progress } = useScan(data);
  const lastScan = data.scan.lastScanAt;
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
  const session = data.boost.session;
  const sessionGame = data.state.games.find((g) => g.id === session?.gameId);
  const cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);
  const booster = data.state.booster;
  const pointerReady = data.capabilities.includes("mouse-precision");
  const used = h.memoryBytes - h.freeMemoryBytes;
  const memoryPercent = h.memoryBytes
    ? Math.round((used / h.memoryBytes) * 100)
    : 0;
  const metrics = [
    {
      label: "Processor",
      value: h.cpu,
      detail: `${h.cores} logical processors`,
      icon: Cpu,
    },
    {
      label: "Graphics",
      value: h.gpu[0] ?? "Unavailable",
      detail: h.gpu.length
        ? "Display adapter detected"
        : "Windows helper required",
      icon: Monitor,
    },
    {
      label: "Memory",
      value: formatBytes(h.memoryBytes),
      detail: `${formatBytes(used)} in use`,
      icon: MemoryStick,
    },
    {
      label: "Storage",
      value: formatBytes(h.drives.reduce((s, d) => s + d.totalBytes, 0)),
      detail: h.drives.length
        ? `${h.drives.length} local drive${h.drives.length === 1 ? "" : "s"}`
        : "No drive readings",
      icon: HardDrive,
    },
  ];
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
  return (
    <>
      {lowered.length > 0 && (
        <div className="notice security-banner" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>Security settings are lowered on this PC.</strong>
            <p>
              {lowered
                .flatMap((a) => a.ids)
                .filter((id) => securityIds.includes(id))
                .map((id) => catalogue.find((o) => o.id === id)?.name)
                .join(", ")}
              .
            </p>
            <Button
              variant="danger"
              disabled={pending || restoring}
              onClick={() => void restoreSecurity()}
            >
              Restore all security settings
            </Button>
          </div>
        </div>
      )}
      {awaitingRestart.length > 0 && (
        <p className="notice" role="status">
          <ActivityIcon size={17} />
          Pending restart: {[...new Set(awaitingRestart)].join(", ")}. Windows
          reads these after the PC restarts.
        </p>
      )}
      <PageTitle
        title="Your setup, in focus."
        subtitle="A clear view of your PC. Every change stays in your hands."
        action={
          <Badge tone={h.source === "demo" ? "amber" : "cyan"}>
            {h.source === "demo"
              ? "Demo hardware"
              : h.source === "windows"
                ? "Windows readings"
                : "Partial readings"}
          </Badge>
        }
      />
      <section className="overview-band">
        <div className="overview-copy">
          <Badge tone="lime">
            <ShieldCheck size={13} />
            Local control
          </Badge>
          <h2>Ready when you are.</h2>
          <p>
            Review your configuration, save a backup, and choose the preferences
            that fit your games.
          </p>
          <Button variant="primary" onClick={() => navigate("Optimizations")}>
            <SlidersHorizontal size={17} />
            Explore optimizations
            <ArrowUpRight size={17} />
          </Button>
        </div>
        <div className="hardware-visual" aria-label="Memory use">
          <div className="chip-frame">
            <Cpu size={48} />
            <span>FRAMEFORGE</span>
          </div>
          <div className="reading">
            <span className="muted">MEMORY IN USE</span>
            <strong>
              {memoryPercent}
              <small>%</small>
            </strong>
            <div className="memory-track">
              <div style={{ width: `${memoryPercent}%` }} />
            </div>
            <span>{formatBytes(h.freeMemoryBytes)} available</span>
          </div>
        </div>
      </section>
      <section className="metric-grid" aria-label="System overview">
        {metrics.map((m) => (
          <article className="metric" key={m.label}>
            <div className="metric-label">
              <m.icon size={18} />
              {m.label}
            </div>
            <h3>{m.value}</h3>
            <span className="muted">{m.detail}</span>
          </article>
        ))}
      </section>
      <div className="dashboard-columns">
        <section>
          <div className="section-title">
            <h2>Make it yours</h2>
            <span className="muted">Configuration, not promises</span>
          </div>
          <div className="action-list">
            <button onClick={() => preview(["mouse-precision"])}>
              <span className="action-icon lime">
                <SlidersHorizontal />
              </span>
              <div>
                <strong>Consistent pointer movement</strong>
                <p className="muted">
                  {pointerReady
                    ? "Review a reversible input preference"
                    : "Preview only: applying requires the desktop app and its Windows helper"}
                </p>
              </div>
              <ArrowUpRight size={19} />
            </button>
            <button onClick={() => navigate("Game library")}>
              <span className="action-icon cyan">
                <Gamepad2 />
              </span>
              <div>
                <strong>Your game library</strong>
                <p className="muted">
                  {data.state.games.length
                    ? `${data.state.games.length} games in your library`
                    : "Add a game and save a profile"}
                </p>
              </div>
              <ArrowUpRight size={19} />
            </button>
            <button
              disabled={pending || running || data.mode === "demo"}
              onClick={() => void run("detectGames", {}, "Game scan finished.")}
            >
              <span className="action-icon cyan">
                <FolderSearch />
              </span>
              <div>
                <strong>{running ? "Scanning for games…" : "Scan now"}</strong>
                <p className="muted">
                  {running
                    ? progress
                      ? `${progress.launcher} (${progress.done}/${progress.total}), ${progress.found} found so far`
                      : "Looking through your launchers in the background"
                    : data.mode === "demo"
                      ? "Requires the desktop app"
                      : lastScan
                        ? `Find installed games. Last scan ${formatTime(lastScan)}`
                        : "Find installed games and add them to your library"}
                </p>
                {running && (
                  <progress
                    aria-label="Game scan progress"
                    max={progress?.total ?? 1}
                    value={progress?.done ?? 0}
                  />
                )}
              </div>
              <ArrowUpRight size={19} />
            </button>
            <button onClick={() => navigate("Restore & backups")}>
              <span className="action-icon amber">
                <Archive />
              </span>
              <div>
                <strong>Keep a way back</strong>
                <p className="muted">
                  {data.backups.length} app configuration backup
                  {data.backups.length === 1 ? "" : "s"}
                </p>
              </div>
              <Badge tone={protectionChip(restore, data.mode).tone}>
                {protectionChip(restore, data.mode).text}
              </Badge>
            </button>
            <button onClick={() => navigate("Game Mode")}>
              {sessionGame ? (
                <GameIcon game={sessionGame} size={40} />
              ) : (
                <span className="action-icon lime">
                  <Play />
                </span>
              )}
              <div>
                <strong>Game Mode</strong>
                <p className="muted">
                  {!data.boost.available
                    ? data.mode === "demo"
                      ? "Requires the desktop app"
                      : "Windows helper missing"
                    : session
                      ? `${sessionGame?.name ?? "Boosted game"}: ${cap(session.mode)} mode, ${session.status}`
                      : `Mode ${cap(booster.mode)}; auto-boost ${booster.autoBoost ? "on" : "off"}; no active session`}
                </p>
              </div>
              <Badge tone={session ? statusTone(session.status) : "neutral"}>
                {session ? session.status : "Idle"}
              </Badge>
            </button>
          </div>
        </section>
        <section>
          <div className="section-title">
            <h2>Recent activity</h2>
            <LinkButton onClick={() => navigate("Activity")}>
              View all
            </LinkButton>
          </div>
          {data.activity.length ? (
            <div className="recent-list">
              {data.activity.slice(0, 4).map((a) => (
                <div key={a.id}>
                  <ActivityIcon size={17} />
                  <div>
                    <strong>{a.label}</strong>
                    <p className="muted">{formatTime(a.at)}</p>
                  </div>
                  <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="A clean starting point"
              description="Your operations and configuration changes will appear here."
            />
          )}
        </section>
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
    </>
  );
}
