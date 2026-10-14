// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  defaultState,
  requests,
  responses,
  type Method,
  type Request,
} from "../shared/contracts";
import { presets } from "../shared/catalogue";
import { request } from "../src/api";
import { Repository } from "../electron/repository";
import { MockPlatform, WindowsPlatform } from "../electron/platform";
import { AppService, type DesktopServices } from "../electron/service";
import { settingsTarget } from "../electron/settingsPages";
import { userDataOverride } from "../electron/userData";
const desktop = (extra: Partial<DesktopServices> = {}): DesktopServices => ({
  pickGame: async () => null,
  detectGames: async () => ({
    games: [],
    warnings: [],
    launchers: [],
    perLauncher: [],
  }),
  scanFolder: async () => null,
  setStartup: () => {},
  version: "test",
  ...extra,
});
const id = () => crypto.randomUUID();
let backupId = "";
// A valid input per method; typecheck forces an entry for every new method.
const inputs: { [M in Method]: () => Request<M> } = {
  bootstrap: () => ({}),
  refresh: () => ({}),
  settings: () => ({
    theme: "dark",
    startup: false,
    notifications: true,
    diagnostics: false,
    autoScan: true,
    autoScanHours: 24,
    keepRunning: true,
    autoBoostAdmin: false,
  }),
  preview: () => ({ ids: ["mouse-precision"] }),
  confirm: () => ({ token: id(), confirmed: true }),
  cancel: () => ({}),
  rollback: () => ({ id: id(), confirmed: true }),
  backup: () => ({ name: "Demo test" }),
  restore: () => ({ id: backupId, confirmed: true }),
  addGame: () => ({}),
  detectGames: () => ({}),
  restoreStatus: () => ({}),
  scanFolder: () => ({ confirmed: true }),
  restorePoints: () => ({}),
  createRestorePoint: () => ({
    name: "Frameforge test",
    confirmed: true,
    bypassThrottle: false,
  }),
  enableSystemProtection: () => ({ confirmed: true }),
  recoverRestoreFrequency: () => ({ confirmed: true }),
  openSystemRestore: () => ({}),
  openSettings: () => ({ page: "graphics" }),
  boostStatus: () => ({}),
  boostConfig: () => defaultState.booster,
  boostStart: () => ({ gameId: id(), confirmed: true }),
  boostStop: () => ({ confirmed: true }),
  boostRecover: () => ({ confirmed: true }),
  runningProcesses: () => ({}),
  networkCheck: () => ({ host: "example.com", count: 10 }),
  launchSettings: () => ({ gameId: id() }),
  launchSettingPreview: () => ({
    gameId: id(),
    setting: "gpuPreference",
    action: "apply",
  }),
  launchSettingApply: () => ({
    gameId: id(),
    setting: "gpuPreference",
    action: "apply",
    confirmed: true,
  }),
  boostPowerPlan: () => ({ action: "create", confirmed: true }),
  boostTimerGlobal: () => ({ action: "enable", confirmed: true }),
  removeGame: () => ({ id: id() }),
  chooseExecutable: () => ({ id: id() }),
  gameIcon: () => ({ id: id() }),
  restoreGame: () => ({ path: "C:\\Games\\Removed" }),
  profile: () => ({ id: id(), boostMode: "global", notes: "" }),
  savePreset: () => ({ name: "Mine", ids: ["mouse-precision"] }),
  removePreset: () => ({ id: id() }),
  clearActivity: () => ({ confirmed: true }),
  restartExplorer: () => ({ confirmed: true }),
  updateStatus: () => ({}),
  updateCheck: () => ({}),
  updateDownload: () => ({}),
  updateInstall: () => ({ when: "now" }),
  trackUsage: () => ({ event: "feature_opened", page: "Dashboard" }),
  monitorStart: () => ({}),
  monitorStop: () => ({}),
  fpsStatus: () => ({}),
  fpsStart: () => ({ gameId: id(), confirmed: true }),
  fpsStop: () => ({ confirmed: true }),
  fpsHistory: () => ({ gameId: id() }),
};
describe("IPC surface", () => {
  it("has identical request, response and handler sets", () => {
    const service = new AppService(
      new Repository(":memory:"),
      new MockPlatform(),
      desktop(),
    );
    const handlers = (service as unknown as { handlers: object }).handlers;
    const keys = Object.keys(requests).sort();
    expect(Object.keys(responses).sort()).toEqual(keys);
    expect(Object.keys(handlers).sort()).toEqual(keys);
  });
  it("demo mode answers every method honestly or says the desktop app is required", async () => {
    // Methods that read or change Windows: the demo must refuse, never fake a result.
    const windowsOnly: Method[] = [
      "preview",
      "confirm",
      "rollback",
      "addGame",
      "chooseExecutable",
      "detectGames",
      "scanFolder",
      "restorePoints",
      "createRestorePoint",
      "enableSystemProtection",
      "recoverRestoreFrequency",
      "openSystemRestore",
      "openSettings",
      "boostStart",
      "boostStop",
      "boostRecover",
      "runningProcesses",
      "networkCheck",
      "launchSettings",
      "launchSettingPreview",
      "launchSettingApply",
      "boostPowerPlan",
      "boostTimerGlobal",
      "monitorStart",
      "fpsStart",
    ];
    localStorage.clear();
    for (const method of Object.keys(requests) as Method[]) {
      const input = (inputs[method] as () => unknown)();
      let answered = false;
      try {
        // request() validates the demo answer against the response schema.
        const output = await request(method, input as Request<typeof method>);
        answered = true;
        if (method === "backup") backupId = (output as { id: string }).id;
      } catch (error) {
        expect((error as Error).message, method).toMatch(/desktop/i);
      }
      if (windowsOnly.includes(method)) expect(answered, method).toBe(false);
    }
  });
  it("opens only allowlisted Windows pages and reports failure", async () => {
    const opened: string[] = [];
    const service = new AppService(
      new Repository(":memory:"),
      new MockPlatform(),
      desktop({
        openSettings: async (page) => {
          opened.push(page);
          return page !== "services";
        },
      }),
    );
    expect(await service.dispatch("openSettings", { page: "startup" })).toBe(
      true,
    );
    await expect(
      service.dispatch("openSettings", { page: "services" }),
    ).rejects.toThrow("could not open");
    await expect(
      service.dispatch("openSettings", { page: "ms-settings:anything" }),
    ).rejects.toThrow();
    expect(opened).toEqual(["startup", "services"]);
  });
  it("drops power-plan when this PC lacks the plan and restores it later", async () => {
    const platform = new WindowsPlatform("unused.exe");
    let failure: string | null = "High performance plan not present.";
    Object.assign(platform, {
      call: async (request: { command: string }) => {
        // The Windows compatibility check is independent of the power plan.
        if (request.command === "supported")
          return {
            ok: true,
            message: "ok",
            supported: ["mouse-precision", "capture-off", "power-plan"],
          };
        if (failure) throw new Error(failure);
        return { ok: true, message: "ok", snapshot: { values: [] } };
      },
    });
    expect(await platform.probe()).toBeNull();
    expect(platform.capabilities).not.toContain("power-plan");
    expect(platform.capabilities).toContain("mouse-precision");
    failure = null;
    expect(await platform.probe()).toBeNull();
    expect(platform.capabilities).toContain("power-plan");
    // A helper failure is an error state, not "not available on this PC".
    failure = "Windows helper timed out.";
    expect(await platform.probe()).toMatch(/timed out/);
    expect(platform.capabilities).toContain("power-plan");
  });
  it("maps each settings page to one fixed target", () => {
    expect(settingsTarget("graphics")).toEqual({
      uri: "ms-settings:display-advancedgraphics",
    });
    expect(settingsTarget("startup")).toEqual({
      uri: "ms-settings:startupapps",
    });
    expect(settingsTarget("network")).toEqual({
      uri: "ms-settings:network-status",
    });
    expect(settingsTarget("services", "D:\\Win")).toEqual({
      file: "D:\\Win\\System32\\services.msc",
    });
  });
  it("honours the profile override only for tests and local absolute paths", () => {
    const dir = { FRAMEFORGE_USER_DATA: "C:\\Temp\\ff" };
    expect(userDataOverride({}, false, "win32")).toBeNull();
    expect(userDataOverride(dir, false, "win32")).toBe("C:\\Temp\\ff");
    // Packaged builds ignore it unless test mode is explicit.
    expect(userDataOverride(dir, true, "win32")).toBeNull();
    expect(
      userDataOverride({ ...dir, FRAMEFORGE_TEST_MODE: "1" }, true, "win32"),
    ).toBe("C:\\Temp\\ff");
    for (const bad of [
      "relative\\dir",
      "\\\\server\\share",
      "\\\\?\\C:\\x",
      "\\\\.\\pipe\\x",
      "\\rooted",
      "//server/share",
    ])
      expect(
        () => userDataOverride({ FRAMEFORGE_USER_DATA: bad }, false, "win32"),
        bad,
      ).toThrow("local absolute path");
  });
  it("writes the sign-in change when Windows differs from the stored value", async () => {
    let windows = false;
    const writes: boolean[] = [];
    const repo = new Repository(":memory:");
    const settings = {
      theme: "dark" as const,
      startup: true,
      notifications: true,
      diagnostics: false,
      autoScan: true,
      autoScanHours: 24,
      keepRunning: true,
      autoBoostAdmin: false,
    };
    repo.updateState({ ...repo.state(), settings });
    const service = new AppService(
      repo,
      new MockPlatform(),
      desktop({
        startupSupported: true,
        startupEnabled: () => windows,
        setStartup: (enabled) => {
          writes.push(enabled);
          windows = enabled;
        },
      }),
    );
    // Stored true, Windows false (removed in Task Manager): toggling on must write.
    expect(service.bootstrap().state.settings.startup).toBe(false);
    await service.dispatch("settings", settings);
    expect(writes).toEqual([true]);
    expect(windows).toBe(true);
  });
  it("shows and verifies Windows' real launch-at-sign-in state", async () => {
    let windows = false;
    const service = new AppService(
      new Repository(":memory:"),
      new MockPlatform(),
      desktop({
        startupSupported: true,
        startupEnabled: () => windows,
        setStartup: () => {},
      }),
    );
    windows = true;
    expect(service.bootstrap().state.settings.startup).toBe(true);
    windows = false;
    // Windows ignored the write: no stored success.
    await expect(
      service.dispatch("settings", {
        theme: "dark",
        startup: true,
        notifications: true,
        diagnostics: false,
      }),
    ).rejects.toThrow("did not accept");
    expect(service.bootstrap().state.settings.startup).toBe(false);
  });
  it("built-in presets only use operations the Windows helper supports", () => {
    const supported = WindowsPlatform.supported;
    for (const preset of presets)
      for (const op of preset.ids) expect(supported, preset.name).toContain(op);
    expect(new Set(presets.map((p) => p.ids.join())).size).toBe(presets.length);
  });
});
