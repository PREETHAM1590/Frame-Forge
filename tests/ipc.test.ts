// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
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
  boostTargets: () => ({ gameId: id() }),
  boostStart: () => ({
    gameId: id(),
    target: {
      pid: 1,
      startTime: "2026-10-13T00:00:00.0000000Z",
      executablePath: "C:\\Games\\game.exe",
      name: "game",
      priority: "Normal",
    },
    confirmed: true,
  }),
  boostStop: () => ({ confirmed: true }),
  removeGame: () => ({ id: id() }),
  profile: () => ({ id: id(), profile: "balanced", notes: "" }),
  gameMode: () => ({ gameId: null, active: false }),
  savePreset: () => ({ name: "Mine", ids: ["mouse-precision"] }),
  removePreset: () => ({ id: id() }),
  clearActivity: () => ({ confirmed: true }),
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
    localStorage.clear();
    for (const method of Object.keys(requests) as Method[]) {
      const input = (inputs[method] as () => unknown)();
      try {
        // request() validates the demo answer against the response schema.
        const output = await request(method, input as Request<typeof method>);
        if (method === "backup") backupId = (output as { id: string }).id;
      } catch (error) {
        expect((error as Error).message, method).toMatch(/desktop/i);
      }
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
    let present = false;
    Object.assign(platform, {
      call: async () => {
        if (!present) throw new Error("High performance plan not present.");
        return { ok: true, message: "ok", snapshot: { values: [] } };
      },
    });
    await platform.probe();
    expect(platform.capabilities).not.toContain("power-plan");
    expect(platform.capabilities).toContain("mouse-precision");
    present = true;
    await platform.probe();
    expect(platform.capabilities).toContain("power-plan");
  });
  it("built-in presets only use operations the Windows helper supports", () => {
    const supported = WindowsPlatform.supported;
    for (const preset of presets)
      for (const op of preset.ids) expect(supported, preset.name).toContain(op);
    expect(new Set(presets.map((p) => p.ids.join())).size).toBe(presets.length);
  });
});
