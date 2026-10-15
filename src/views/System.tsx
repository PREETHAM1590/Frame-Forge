import { useState } from "react";
import {
  Play,
  Cpu,
  Monitor,
  MemoryStick,
  HardDrive,
  RefreshCw,
  Settings2,
  Archive,
  Info,
  ShieldCheck,
} from "lucide-react";
import {
  PageTitle,
  Button,
  Badge,
  Toggle,
  Busy,
  formatBytes,
  formatTime,
} from "../components/ui";
import type { ViewProps } from "../types";
import { UpdateCard } from "../components/UpdatePanel";
import { AdminAccess } from "../components/AdminAccess";
import { OverlaySettings } from "../components/OverlaySettings";
import { useUpdate } from "../useUpdate";
import { Cleanup } from "./system/Cleanup";
import { DriverCheck } from "./system/DriverCheck";
import { HotkeysSection } from "./HotkeysSection";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
export function System({ data, run, pending }: ViewProps) {
  const h = data.hardware;
  const [refreshing, setRefreshing] = useState(false);
  return (
    <>
      <PageTitle
        title="System information"
        subtitle={`Read-only discovery / collected ${formatTime(h.collectedAt)}`}
        action={
          <Button
            disabled={pending}
            onClick={async () => {
              setRefreshing(true);
              await run("refresh", {}, "System readings refreshed.");
              setRefreshing(false);
            }}
          >
            {refreshing ? (
              <Busy label="Refreshing" />
            ) : (
              <>
                <RefreshCw size={17} />
                Refresh
              </>
            )}
          </Button>
        }
      />
      {h.warnings.map((w) => (
        <div className="notice" key={w}>
          <Info size={18} />
          {w}
        </div>
      ))}
      <section className="system-section">
        <h2>
          <Cpu size={20} />
          Processor
        </h2>
        <dl>
          <dt>Model</dt>
          <dd>{h.cpu || "Unavailable"}</dd>
          <dt>Logical processors</dt>
          <dd>{h.cores || "Unavailable"}</dd>
          <dt>Live CPU utilization & temperature</dt>
          <dd>
            Open Monitor for live CPU use and temperature readings when Windows
            exposes them. Frameforge does not install a sensor driver.
          </dd>
        </dl>
      </section>
      <section className="system-section">
        <h2>
          <Monitor size={20} />
          Graphics & display
        </h2>
        <dl>
          <dt>Adapters</dt>
          <dd>{h.gpu.join(" / ") || "Unavailable"}</dd>
          <dt>Driver information</dt>
          <dd>{h.drivers.join(" / ") || "Unavailable"}</dd>
          <dt>Displays</dt>
          <dd>{h.displays.join(" / ") || "Unavailable"}</dd>
          <dt>Temperature, live GPU use & FPS</dt>
          <dd>
            Open Monitor for live GPU use, available temperature readings and
            optional DirectX FPS capture. FPS capture needs administrator
            approval; Vulkan, OpenGL and some anti-cheat games are not measured.
          </dd>
        </dl>
      </section>
      <section className="system-section">
        <h2>
          <MemoryStick size={20} />
          Memory
        </h2>
        <dl>
          <dt>Installed / visible</dt>
          <dd>{formatBytes(h.memoryBytes)}</dd>
          <dt>Available</dt>
          <dd>{formatBytes(h.freeMemoryBytes)}</dd>
          <dt>Used</dt>
          <dd>{formatBytes(h.memoryBytes - h.freeMemoryBytes)}</dd>
        </dl>
      </section>
      <section className="system-section">
        <h2>
          <HardDrive size={20} />
          Drives & operating system
        </h2>
        <dl>
          {h.drives.map((d) => (
            <div className="dl-row" key={d.name}>
              <dt>{d.name}</dt>
              <dd>
                {formatBytes(d.freeBytes)} free of {formatBytes(d.totalBytes)}
              </dd>
            </div>
          ))}
          <dt>Operating system</dt>
          <dd>{h.os || "Unavailable"}</dd>
          <dt>Data source</dt>
          <dd>
            <Badge tone={h.source === "demo" ? "amber" : "cyan"}>
              {h.source}
            </Badge>
          </dd>
        </dl>
      </section>
      <DriverCheck />
      <Cleanup />
    </>
  );
}
export function Settings({ data, run, pending, navigate }: ViewProps) {
  const settings = data.state.settings;
  const analyticsAvailable = useUpdate().status?.analyticsAvailable === true;
  const update = (patch: Partial<typeof settings>) =>
    void run("settings", { ...settings, ...patch }, "Preferences saved.");
  return (
    <>
      <PageTitle
        title="Settings"
        subtitle="A local app, configured your way."
      />
      <section className="settings-section">
        <h2>
          <Settings2 size={20} />
          Preferences
        </h2>
        <div className="setting-row">
          <div>
            <label htmlFor="theme">Appearance</label>
            <p className="muted">Choose a workspace theme.</p>
          </div>
          <select
            id="theme"
            value={settings.theme}
            disabled={pending}
            onChange={(e) =>
              update({ theme: e.target.value as "dark" | "light" })
            }
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
        <Toggle
          label="Launch at sign-in"
          description={
            data.startupSupported
              ? "Start Frameforge when you sign in to Windows."
              : "Available in the installed app. This is a development or browser build, so the switch is off here."
          }
          checked={settings.startup}
          disabled={pending || !data.startupSupported}
          onChange={(startup) => update({ startup })}
        />
        <Toggle
          label="Keep running in the background"
          description="Closing the window leaves Frameforge in the tray so auto-boost keeps watching for your games. The window is closed completely, so the tray uses very little memory. Launch at sign-in starts it there."
          checked={settings.keepRunning}
          disabled={pending}
          onChange={(keepRunning) => update({ keepRunning })}
        />
        <div className="setting-row">
          <div>
            <label htmlFor="close-action">When I close the window</label>
            <p className="muted">
              Minimize to tray keeps auto-boost watching; Quit exits Frameforge
              (a live boost is restored first). The tray menu always has Quit
              Frameforge.
            </p>
          </div>
          <select
            id="close-action"
            value={settings.closeAction}
            disabled={pending}
            onChange={(e) =>
              update({
                closeAction: e.target.value as typeof settings.closeAction,
                ...(e.target.value === "tray" && { keepRunning: true }),
              })
            }
          >
            <option value="ask">Ask me</option>
            <option value="tray">Minimize to tray</option>
            <option value="quit">Quit</option>
          </select>
        </div>
        <Toggle
          label="Allow admin prompts during auto-boost"
          description="Off: auto-boost skips the steps that need administrator approval (services, standby list) so Windows never asks while you play. On: it may open the Windows prompt."
          checked={settings.autoBoostAdmin}
          disabled={pending}
          onChange={(autoBoostAdmin) => update({ autoBoostAdmin })}
        />
        <Toggle
          label="Clean up when a boost starts"
          description="Close the apps you picked and trim the memory big background programs hold, before every boost."
          checked={settings.boostCleanup !== false}
          disabled={pending}
          onChange={(boostCleanup) => update({ boostCleanup })}
        />
        <Toggle
          label="Reopen closed apps after the boost"
          description="Starts the apps the clean-up closed once the boost ends. Their old windows and tabs are not restored. Off by default."
          checked={settings.relaunchClosed === true}
          disabled={pending}
          onChange={(relaunchClosed) => update({ relaunchClosed })}
        />
        <Toggle
          label="In-app notifications"
          description="Show success notifications for completed app actions. Errors are always shown."
          checked={settings.notifications}
          disabled={pending}
          onChange={(notifications) => update({ notifications })}
        />
        <Toggle
          label="Local diagnostics"
          description="Record request timing in the local activity log. Nothing is uploaded."
          checked={settings.diagnostics}
          disabled={pending}
          onChange={(diagnostics) => update({ diagnostics })}
        />
        <Toggle
          label="Scan for games automatically on startup"
          description="Look for newly installed games in the background and add them to your library. Games you remove are not added back."
          checked={settings.autoScan}
          disabled={pending || data.mode === "demo"}
          onChange={(autoScan) => update({ autoScan })}
        />
        {settings.autoScan && data.mode !== "demo" && (
          <div className="setting-row">
            <div>
              <label htmlFor="scan-interval">Scan at most every</label>
              <p className="muted">
                A scan runs at start only when the last one is older than this.
              </p>
            </div>
            <select
              id="scan-interval"
              value={settings.autoScanHours}
              disabled={pending}
              onChange={(e) =>
                update({ autoScanHours: Number(e.target.value) })
              }
            >
              {[
                [6, "6 hours"],
                [12, "12 hours"],
                [24, "24 hours"],
                [72, "3 days"],
                [168, "7 days"],
              ].map(([hours, label]) => (
                <option key={hours} value={hours}>
                  {label}
                </option>
              ))}
              {![6, 12, 24, 72, 168].includes(settings.autoScanHours) && (
                <option value={settings.autoScanHours}>
                  {settings.autoScanHours} hours
                </option>
              )}
            </select>
          </div>
        )}
      </section>
      <section className="settings-section">
        <h2>
          <Play size={20} />
          Booster
        </h2>
        <div className="setting-row">
          <div>
            <strong>Game Mode</strong>
            <p className="muted">
              Booster options and sessions live on the Game Mode page.
            </p>
          </div>
          <Button onClick={() => navigate("Game Mode")}>Open Game Mode</Button>
        </div>
      </section>
      <HotkeysSection
        hotkeys={settings.hotkeys}
        pending={pending}
        save={(hotkeys) => update({ hotkeys })}
      />
      <OverlaySettings
        saved={settings.overlay}
        disabled={pending}
        save={(overlay) => update({ overlay })}
      />
      <AdminAccess disabled={pending || data.mode === "demo"} />
      <section className="settings-section">
        <h2>
          <ShieldCheck size={20} />
          Privacy and updates
        </h2>
        <Toggle
          label="Check for updates automatically"
          description="At start and every 6 hours. Contacts github.com only. Nothing is downloaded or installed until you choose."
          checked={settings.updateCheck === true}
          disabled={pending || data.mode === "demo"}
          onChange={(updateCheck) => update({ updateCheck })}
        />
        <Toggle
          label="Install downloaded updates when I quit"
          description="Otherwise an update waits until you press Restart to update."
          checked={settings.updateAutoInstall === true}
          disabled={pending || data.mode === "demo"}
          onChange={(updateAutoInstall) => update({ updateAutoInstall })}
        />
        <Toggle
          label="Share anonymous usage statistics"
          description={
            analyticsAvailable
              ? "Off by default. Sends only: app start (version, Windows build), Game Mode mode, optimization and preset ids, update installed, and which page you open. No game names, paths, user or PC names. Turning it off stops sending immediately."
              : "Not available in this build."
          }
          checked={analyticsAvailable && settings.analytics === true}
          disabled={pending || !analyticsAvailable}
          onChange={(analytics) => update({ analytics })}
        />
        <UpdateCard always />
      </section>
      <section className="settings-section">
        <h2>
          <Archive size={20} />
          Data management
        </h2>
        <div className="setting-row">
          <div>
            <strong>Configuration backups</strong>
            <p className="muted">
              Save or restore app settings, profiles and presets.
            </p>
          </div>
          <Button onClick={() => navigate("Restore & backups")}>
            Manage backups
          </Button>
        </div>
        <div className="setting-row">
          <div>
            <strong>Activity and recovery records</strong>
            <p className="muted">
              Inspect operations and clear completed logs.
            </p>
          </div>
          <Button onClick={() => navigate("Activity")}>Open activity</Button>
        </div>
      </section>
      <DiagnosticsPanel
        run={run}
        pending={pending}
        desktop={data.mode === "desktop"}
      />
      <section className="settings-section">
        <h2>
          <Info size={20} />
          About Frameforge
        </h2>
        <dl>
          <dt>Version</dt>
          <dd>{data.version}</dd>
          <dt>Runtime</dt>
          <dd>
            {data.mode === "desktop" ? "Electron desktop" : "Browser demo"}
          </dd>
          <dt>Usage statistics</dt>
          <dd>
            {settings.analytics === true && analyticsAvailable
              ? "Anonymous, opted in"
              : "Off"}
          </dd>
          <dt>Windows operation access</dt>
          <dd>
            {data.capabilities.length
              ? `${data.capabilities.length} supported Windows changes`
              : "Unavailable; desktop helper required"}
          </dd>
        </dl>
      </section>
    </>
  );
}
