import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  UpdateManager,
  notesToText,
  type UpdaterLike,
} from "../electron/updater";
import { Analytics, validAppKey } from "../electron/analytics";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checks = 0;
  installs = 0;
  info: { version: string; releaseNotes?: unknown } | null = {
    version: "1.3.0",
    releaseNotes: "<h1>New</h1><script>alert(1)</script><p>Fast &amp; safe</p>",
  };
  async checkForUpdates() {
    this.checks++;
    if (this.info) this.emit("update-available", this.info);
    else this.emit("update-not-available");
  }
  async downloadUpdate() {
    this.emit("download-progress", { percent: 50 });
    this.emit("update-downloaded");
  }
  quitAndInstall() {
    this.installs++;
  }
}
const make = (
  u: FakeUpdater | null,
  over: { boost?: boolean; auto?: boolean } = {},
) => {
  const seen: string[] = [];
  const m = new UpdateManager({
    updater: u as UpdaterLike | null,
    current: "1.2.2",
    analyticsAvailable: false,
    boostActive: () => over.boost ?? false,
    autoCheck: () => over.auto ?? true,
    notify: (s) => seen.push(s.state),
    intervalMs: 1000,
  });
  return { m, seen };
};

describe("update manager", () => {
  it("never downloads by itself and strips HTML from notes", async () => {
    const u = new FakeUpdater();
    const { m } = make(u);
    expect(u.autoDownload).toBe(false);
    expect(u.autoInstallOnAppQuit).toBe(false);
    await m.check();
    expect(m.status.state).toBe("available");
    expect(m.status.version).toBe("1.3.0");
    expect(m.status.notes).toBe("New\nFast & safe");
    expect(m.status.notes).not.toContain("alert");
  });
  it("download, then install now or on quit", async () => {
    const u = new FakeUpdater();
    const { m } = make(u);
    await m.check();
    await m.download();
    expect(m.status.state).toBe("downloaded");
    m.install("onQuit");
    expect(u.autoInstallOnAppQuit).toBe(false);
    expect(m.status.installOnQuit).toBe(true);
    m.prepareQuit(false);
    expect(u.autoInstallOnAppQuit).toBe(true);
    m.install("now");
    expect(u.installs).toBe(1);
  });
  it("refuses to install mid-boost", async () => {
    const u = new FakeUpdater();
    const { m } = make(u, { boost: true });
    await m.check();
    await m.download();
    expect(() => m.install("now")).toThrow(/Game Mode/);
    expect(u.installs).toBe(0);
    expect(() => m.install("onQuit")).not.toThrow();
  });
  it("reports no update and errors", async () => {
    const u = new FakeUpdater();
    u.info = null;
    const { m } = make(u);
    await m.check();
    expect(m.status.state).toBe("none");
    u.checkForUpdates = async () => {
      throw new Error("offline");
    };
    await m.check();
    expect(m.status.state).toBe("error");
    expect(m.status.error).toBe("offline");
  });
  it("arms quit installation only after the boost has ended", async () => {
    const u = new FakeUpdater();
    const state = { boost: true };
    const { m } = make(u, state);
    await m.check();
    await m.download();
    m.install("onQuit");
    expect(u.autoInstallOnAppQuit).toBe(false);
    m.prepareQuit(true);
    expect(u.autoInstallOnAppQuit).toBe(false);
    state.boost = false;
    m.prepareQuit(false);
    expect(u.autoInstallOnAppQuit).toBe(true);
    state.boost = true;
    m.prepareQuit(false);
    expect(u.autoInstallOnAppQuit).toBe(false);
  });
  it("checks at start and every interval only when allowed and not boosting", () => {
    vi.useFakeTimers();
    try {
      const u = new FakeUpdater();
      const { m } = make(u);
      m.start();
      expect(u.checks).toBe(1);
      m.stop();
      const off = new FakeUpdater();
      make(off, { auto: false }).m.start();
      expect(off.checks).toBe(0);
      const busy = new FakeUpdater();
      make(busy, { boost: true }).m.start();
      expect(busy.checks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("is unsupported without an updater", async () => {
    const { m } = make(null);
    expect(m.status.state).toBe("unsupported");
    await m.check();
    expect(() => m.install("now")).toThrow();
  });
  it("converts array release notes to text", () => {
    expect(notesToText([{ version: "1", note: "<b>a</b>" }])).toBe("a");
    expect(notesToText(undefined)).toBe("");
  });
});

describe("analytics", () => {
  const sdk = () => ({ trackEvent: vi.fn(async () => {}) });
  it("sends nothing when not opted in or without a key", () => {
    const s = sdk();
    expect(
      new Analytics(s, () => false).track("mode_started", { mode: "custom" }),
    ).toBe(false);
    expect(
      new Analytics(null, () => true).track("mode_started", { mode: "custom" }),
    ).toBe(false);
    expect(s.trackEvent).not.toHaveBeenCalled();
  });
  it("sends allowlisted events and stops immediately when turned off", () => {
    const s = sdk();
    let on = true;
    const a = new Analytics(s, () => on);
    expect(a.track("mode_started", { mode: "performance" })).toBe(true);
    expect(a.track("feature_opened", { page: "Settings" })).toBe(true);
    expect(
      a.track("app_started", { version: "1.2.2", os_build: "26100" }),
    ).toBe(true);
    on = false;
    expect(a.track("mode_started", { mode: "performance" })).toBe(false);
    expect(s.trackEvent).toHaveBeenCalledTimes(3);
  });
  it("drops unknown events, extra properties and free text", () => {
    const s = sdk();
    const a = new Analytics(s, () => true);
    expect(a.track("game_started", { name: "Witcher" })).toBe(false);
    expect(a.track("mode_started", { mode: "C:\\Games\\x" })).toBe(false);
    expect(a.track("mode_started", { mode: "custom", user: "bob" })).toBe(
      false,
    );
    expect(a.track("optimization_applied", { id: "not-an-id" })).toBe(false);
    expect(a.track("preset_applied", { id: "My custom preset" })).toBe(false);
    expect(s.trackEvent).not.toHaveBeenCalled();
  });
  it("accepts US and EU keys only", () => {
    expect(validAppKey("A-EU-1234567890")).toBe(true);
    expect(validAppKey("A-US-1234567890")).toBe(true);
    expect(validAppKey("A-SH-1234567890")).toBe(false);
    expect(validAppKey("")).toBe(false);
    expect(validAppKey(undefined)).toBe(false);
  });
});
