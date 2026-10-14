import { describe, expect, it } from "vitest";
import { HealthFactsSchema, HealthReportSchema } from "../shared/contracts";
import type { HealthFacts } from "../shared/contracts";
import { evaluateHealth, type HealthContext } from "../shared/health";

const GB = 1024 ** 3;
const gameId = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-10-15T00:00:00Z");
// A healthy desktop; each test overrides one area.
const healthy = (): HealthFacts => ({
  battery: { present: false, onAc: true, saver: false, percent: null },
  powerMode: {
    overlay: "balanced",
    planGuid: "x",
    planName: "High performance",
  },
  gpus: [
    {
      name: "NVIDIA GeForce RTX 4070",
      vendor: "nvidia",
      driverVersion: "32.0.15.6094",
      driverDate: "2026-08-01",
      integrated: false,
    },
  ],
  gpuPreferences: [],
  nvidia: null,
  display: { width: 1920, height: 1080, currentHz: 240, maxHz: 240 },
  memory: {
    totalBytes: 32 * GB,
    availableBytes: 20 * GB,
    usedPercent: 38,
    sticks: [
      { capacityBytes: 16 * GB, speedMTs: 6000, configuredMTs: 6000, bank: "A", slot: "A1" },
      { capacityBytes: 16 * GB, speedMTs: 6000, configuredMTs: 6000, bank: "B", slot: "B1" },
    ],
    slots: 2,
  },
  cpuName: "CPU",
  cpuPerformancePercent: 100,
  drives: [
    { name: "C:", totalBytes: 1000 * GB, freeBytes: 500 * GB, system: true, mediaType: "ssd" },
  ],
  gameMode: true,
  hags: 2,
  vbs: false,
  hvci: false,
  pendingReboot: [],
  startupApps: 4,
  overlays: [],
  vendorApp: null,
  topRam: [],
  topCpu: [],
});
const ctx = (extra: Partial<HealthContext> = {}): HealthContext => ({
  games: [],
  now,
  hasAbPair: true,
  ...extra,
});
const check = (facts: HealthFacts, id: string, c = ctx()) =>
  evaluateHealth(facts, c).checks.find((x) => x.id === id)!;

describe("health checks", () => {
  it("scores a healthy desktop high and passes the contract", () => {
    const report = evaluateHealth(healthy(), ctx());
    expect(HealthReportSchema.parse(report).score).toBeGreaterThanOrEqual(95);
    expect(report.topIssues).toEqual([]);
    expect(report.checks.map((c) => c.id)).toContain("ram-channels");
  });

  it("flags a laptop on battery as the top issue and Battery Saver as a warning", () => {
    const f = healthy();
    f.battery = { present: true, onAc: false, saver: false, percent: 60 };
    const c = check(f, "power-source");
    expect(c.status).toBe("bad");
    expect(c.top).toBe(true);
    expect(c.fix).toMatchObject({ kind: "settings", page: "power" });
    expect(evaluateHealth(f, ctx()).topIssues[0]).toBe("power-source");
    f.battery = { present: true, onAc: true, saver: true, percent: 100 };
    expect(check(f, "power-source").status).toBe("warn");
  });

  it("explains that the power mode slider does not apply under another plan", () => {
    const f = healthy();
    f.powerMode = { overlay: "balanced", planGuid: "x", planName: "Frameforge High performance" };
    expect(check(f, "power-mode").explanation).toMatch(/only applies with the Balanced plan/);
    f.powerMode = { overlay: "best-efficiency", planGuid: "y", planName: "Balanced" };
    expect(check(f, "power-mode").status).toBe("warn");
    expect(check(f, "power-plan").fix).toMatchObject({ kind: "optimization", ids: ["power-plan"] });
    f.powerMode.planName = "Power saver";
    expect(check(f, "power-plan").status).toBe("bad");
  });

  it("asks for the laptop maker's mode and never claims to read it", () => {
    const f = healthy();
    f.battery = { present: true, onAc: true, saver: false, percent: 100 };
    f.vendorApp = "NitroSense";
    const c = check(f, "vendor-mode");
    expect(c.status).toBe("warn");
    expect(c.summary).toMatch(/cannot be read/);
    expect(c.steps.join(" ")).toMatch(/NitroSense/);
    expect(c.top).toBe(true);
    f.vendorApp = null;
    expect(check(f, "vendor-mode").status).toBe("unknown");
    expect(check(healthy(), "vendor-mode").status).toBe("good");
  });

  it("finds a library game that is not set to the high-performance GPU on a hybrid laptop", () => {
    const f = healthy();
    f.gpus.push({ name: "Intel(R) UHD Graphics", vendor: "intel", driverVersion: "1", driverDate: "2025-01-01", integrated: true });
    const games = [{ id: gameId, name: "VALORANT", executablePath: "C:\\Riot\\VALORANT.exe" }];
    f.gpuPreferences = [{ gameId, exe: "VALORANT.exe", preference: null }];
    const c = check(f, "gpu-routing", ctx({ games }));
    expect(c.status).toBe("bad");
    expect(c.fix).toMatchObject({ kind: "launchSetting", gameId, setting: "gpuPreference" });
    f.gpuPreferences = [{ gameId, exe: "VALORANT.exe", preference: "high-performance" }];
    expect(check(f, "gpu-routing", ctx({ games })).status).toBe("good");
    expect(check(f, "gpu-routing").status).toBe("unknown");
    expect(check(healthy(), "gpu-routing").status).toBe("good");
  });

  it("treats a refresh rate within one Hz of the maximum as correct", () => {
    const f = healthy();
    f.display = { width: 1920, height: 1080, currentHz: 239, maxHz: 240 };
    expect(check(f, "refresh-rate").status).toBe("good");
    f.display = { width: 1920, height: 1080, currentHz: 144, maxHz: 240 };
    const c = check(f, "refresh-rate");
    expect(c.status).toBe("bad");
    expect(c.fix).toMatchObject({ kind: "settings", page: "display" });
    f.display = null;
    expect(check(f, "refresh-rate").status).toBe("unknown");
  });

  it("reports single-channel memory as bad with a cited estimate, and dual channel as good", () => {
    const f = healthy();
    f.memory.sticks = [f.memory.sticks[0]!];
    const c = check(f, "ram-channels");
    expect(c.status).toBe("bad");
    expect(c.impact).toMatch(/Estimate/);
    expect(c.impact).toMatch(/TechSpot/);
    expect(check(healthy(), "ram-channels").status).toBe("good");
    f.memory.slots = null;
    expect(check(f, "ram-channels").status).toBe("unknown");
  });

  it("only advises XMP on desktops, not on laptops whose CPU limits memory speed", () => {
    const f = healthy();
    f.memory.sticks = f.memory.sticks.map((s) => ({ ...s, speedMTs: 5600, configuredMTs: 5200 }));
    expect(check(f, "ram-speed").status).toBe("warn");
    expect(check(f, "ram-speed").steps.join(" ")).toMatch(/XMP/);
    f.battery = { present: true, onAc: true, saver: false, percent: 100 };
    const laptop = check(f, "ram-speed");
    expect(laptop.status).toBe("good");
    expect(laptop.steps).toEqual([]);
  });

  it("reads GPU throttling and temperature", () => {
    const f = healthy();
    f.nvidia = { name: "RTX", driverVersion: "1", temperatureC: 88, clockMHz: 1200, maxClockMHz: 3000, powerDrawW: 80, powerLimitW: null, pState: "P0", throttleReasons: ["thermal slowdown"] };
    const c = check(f, "thermals");
    expect(c.status).toBe("warn");
    expect(c.summary).toMatch(/88 C/);
    f.nvidia.throttleReasons = [];
    f.nvidia.temperatureC = 55;
    expect(check(f, "thermals").status).toBe("good");
    f.nvidia = null;
    expect(check(f, "thermals").status).toBe("unknown");
  });

  it("flags a nearly full system drive and a game on a hard disk", () => {
    const f = healthy();
    f.drives = [
      { name: "C:", totalBytes: 500 * GB, freeBytes: 60 * GB, system: true, mediaType: "ssd" },
      { name: "D:", totalBytes: 500 * GB, freeBytes: 300 * GB, system: false, mediaType: "hdd" },
    ];
    expect(check(f, "storage").status).toBe("warn");
    f.drives[0]!.freeBytes = 40 * GB;
    expect(check(f, "storage").status).toBe("bad");
    f.drives[0]!.freeBytes = 300 * GB;
    const games = [{ id: gameId, name: "G", executablePath: "D:\\G\\g.exe" }];
    expect(check(f, "storage", ctx({ games })).summary).toMatch(/hard disk/);
    expect(check(healthy(), "storage").status).toBe("good");
  });

  it("flags high memory use with the biggest apps named", () => {
    const f = healthy();
    f.memory.usedPercent = 92;
    f.topRam = [
      { name: "brave", count: 20, cpuPercent: 2, workingSetBytes: 2 * GB },
      { name: "Code", count: 10, cpuPercent: 1, workingSetBytes: 1.5 * GB },
    ];
    const c = check(f, "ram-pressure");
    expect(c.status).toBe("bad");
    expect(c.summary).toMatch(/brave 2.0 GB/);
    expect(c.fix).toMatchObject({ kind: "navigate", page: "Game Mode" });
    f.memory.usedPercent = 82;
    expect(check(f, "ram-pressure").status).toBe("warn");
    f.memory.usedPercent = 60;
    expect(check(f, "ram-pressure").status).toBe("good");
  });

  it("flags background CPU hogs, startup apps, overlays and a pending restart", () => {
    const f = healthy();
    f.topCpu = [
      { name: "node", count: 9, cpuPercent: 14, workingSetBytes: GB },
      { name: "python", count: 2, cpuPercent: 12, workingSetBytes: GB },
    ];
    expect(check(f, "background-cpu").status).toBe("warn");
    f.startupApps = 18;
    expect(check(f, "startup-apps").status).toBe("bad");
    f.overlays = ["Discord"];
    expect(check(f, "overlays").summary).toBe("Discord");
    f.pendingReboot = ["Windows Update"];
    expect(check(f, "pending-reboot").status).toBe("warn");
    f.pendingReboot = ["a pending file replace"];
    expect(check(f, "pending-reboot").status).toBe("good");
  });

  it("explains VBS as a trade-off and links to Windows Security without changing it", () => {
    const f = healthy();
    f.vbs = true;
    f.hvci = true;
    const c = check(f, "vbs");
    expect(c.status).toBe("warn");
    expect(c.impact).toMatch(/trade-off/);
    expect(c.fix).toMatchObject({ kind: "settings", page: "coreIsolation" });
    expect(check(f, "game-mode").explanation).toMatch(/never changes it/);
  });

  it("asks for a baseline until an FPS capture pair exists", () => {
    expect(check(healthy(), "ab-baseline", ctx({ hasAbPair: false })).status).toBe("warn");
    expect(check(healthy(), "ab-baseline").status).toBe("good");
  });

  it("flags an old driver", () => {
    const f = healthy();
    f.gpus[0]!.driverDate = "2024-01-01";
    expect(check(f, "gpu-driver").status).toBe("warn");
  });

  it("accepts the helper's JSON shape", () => {
    expect(() => HealthFactsSchema.parse(healthy())).not.toThrow();
  });
});
