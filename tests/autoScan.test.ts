import { describe, it, expect, vi } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";
import { AppService, type DesktopServices } from "../electron/service";
import {
  dismissPath,
  lastScanKey,
  maxDismissed,
  shouldAutoScan,
} from "../electron/scanPolicy";
import type { AppEvent, Game } from "../shared/contracts";

const hour = 3600_000;
const now = Date.parse("2026-10-13T12:00:00Z");
const on = { autoScan: true, autoScanHours: 24 };

describe("shouldAutoScan", () => {
  it("scans on first launch, when no scan is recorded", () => {
    expect(shouldAutoScan(null, on, now)).toBe(true);
    expect(shouldAutoScan(undefined, on, now)).toBe(true);
    expect(shouldAutoScan("not a date", on, now)).toBe(true);
  });
  it("waits for the interval", () => {
    const at = (h: number) => new Date(now - h * hour).toISOString();
    expect(shouldAutoScan(at(1), on, now)).toBe(false);
    expect(shouldAutoScan(at(23.9), on, now)).toBe(false);
    expect(shouldAutoScan(at(24), on, now)).toBe(true);
    expect(shouldAutoScan(at(5), { ...on, autoScanHours: 6 }, now)).toBe(false);
    expect(shouldAutoScan(at(7), { ...on, autoScanHours: 6 }, now)).toBe(true);
  });
  it("treats a timestamp in the future as stale", () => {
    expect(shouldAutoScan(new Date(now + hour).toISOString(), on, now)).toBe(
      true,
    );
  });
  it("never scans when the setting is off, even on first launch", () => {
    expect(shouldAutoScan(null, { ...on, autoScan: false }, now)).toBe(false);
  });
});

describe("dismissPath", () => {
  it("lower-cases, de-duplicates, keeps the newest and caps the list", () => {
    expect(dismissPath(["c:\\a"], "C:\\B")).toEqual(["c:\\a", "c:\\b"]);
    expect(dismissPath(["c:\\a", "c:\\b"], "C:\\A")).toEqual([
      "c:\\b",
      "c:\\a",
    ]);
    const full = Array.from({ length: maxDismissed }, (_, i) => `c:\\g${i}`);
    const next = dismissPath(full, "C:\\new");
    expect(next).toHaveLength(maxDismissed);
    expect(next.at(-1)).toBe("c:\\new");
    expect(next[0]).toBe("c:\\g1");
  });
});

const game = (name: string, dir: string, source: Game["source"] = "steam") =>
  ({
    id: crypto.randomUUID(),
    name,
    path: dir,
    source,
    executablePath: null,
    profile: "balanced",
    boostMode: "global",
    notes: "",
  }) satisfies Game;

function setup(found: Game[] | (() => Promise<Game[]>)) {
  const repo = new Repository(":memory:");
  const events: AppEvent[] = [];
  const detectGames = vi.fn(async () => ({
    games: typeof found === "function" ? await found() : found,
    warnings: [],
    launchers: ["Steam"],
    perLauncher: [],
  }));
  const desktop: DesktopServices = {
    pickGame: async () => null,
    detectGames,
    scanFolder: async () => null,
    setStartup: () => {},
    version: "test",
    notify: (event) => events.push(event),
  };
  const service = new AppService(repo, new MockPlatform(), desktop);
  return { repo, service, detectGames, events };
}
const libraryNames = (repo: Repository) =>
  repo.state().games.map((g) => g.name);

describe("automatic game scan", () => {
  it("runs on first launch, adds new games, logs it and records the time", async () => {
    const { repo, service, detectGames, events } = setup([
      game("Alpha", "C:\\Games\\Alpha"),
      game("Beta", "C:\\Games\\Beta"),
    ]);
    expect(service.bootstrap().scan).toEqual({
      running: false,
      lastScanAt: null,
    });
    await service.autoScan(now);
    expect(detectGames).toHaveBeenCalledTimes(1);
    expect(libraryNames(repo)).toEqual(["Alpha", "Beta"]);
    expect(typeof repo.meta(lastScanKey)).toBe("string");
    expect(service.bootstrap().scan.lastScanAt).toBe(repo.meta(lastScanKey));
    expect(repo.activity().map((a) => a.label)).toContain(
      "Automatic game scan completed",
    );
    expect(events.filter((e) => e.type === "scan")).toEqual([
      { type: "scan", phase: "started", auto: true, added: 0 },
      { type: "scan", phase: "finished", auto: true, added: 2 },
    ]);
  });

  it("does not scan again until the interval has passed", async () => {
    const { repo, service, detectGames } = setup([game("Alpha", "C:\\A")]);
    await service.autoScan(Date.now());
    await service.autoScan(Date.now() + 23 * hour);
    expect(detectGames).toHaveBeenCalledTimes(1);
    await service.autoScan(Date.now() + 25 * hour);
    expect(detectGames).toHaveBeenCalledTimes(2);
    // Alpha was already there the second time: no duplicate.
    expect(libraryNames(repo)).toEqual(["Alpha"]);
  });

  it("honours the setting and a manual scan counts as a recent scan", async () => {
    const { repo, service, detectGames } = setup([game("Alpha", "C:\\A")]);
    repo.updateState({
      ...repo.state(),
      settings: { ...repo.state().settings, autoScan: false },
    });
    await service.autoScan(now);
    expect(detectGames).not.toHaveBeenCalled();
    repo.updateState({
      ...repo.state(),
      settings: { ...repo.state().settings, autoScan: true },
    });
    await service.dispatch("detectGames", {});
    await service.autoScan(Date.now());
    expect(detectGames).toHaveBeenCalledTimes(1);
  });

  it("leaves the scan due when detection fails, and logs it", async () => {
    const { repo, service, events } = setup(async () => {
      throw new Error("registry unavailable");
    });
    await expect(service.autoScan(now)).resolves.toBeUndefined();
    expect(repo.meta(lastScanKey)).toBeNull();
    expect(repo.activity()[0]).toMatchObject({
      label: "Automatic game scan failed",
      status: "failed",
    });
    expect(events.at(-1)).toMatchObject({ type: "scan", phase: "finished" });
    expect(service.bootstrap().scan.running).toBe(false);
  });

  it("shares one scan between startup, Rescan and Scan now", async () => {
    let release = () => {};
    const { service, detectGames, events } = setup(
      () =>
        new Promise((resolve) => {
          release = () => resolve([game("Alpha", "C:\\A")]);
        }),
    );
    const auto = service.autoScan(now);
    const manual = service.dispatch("detectGames", {});
    await Promise.resolve();
    expect(service.bootstrap().scan.running).toBe(true);
    release();
    await Promise.all([auto, manual]);
    expect(detectGames).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "scan")).toHaveLength(2);
  });
});

describe("removed games stay removed", () => {
  it("does not add a removed game back on automatic or manual scans", async () => {
    const alpha = game("Alpha", "C:\\Games\\Alpha");
    const beta = game("Beta", "C:\\Games\\Beta");
    const { repo, service } = setup([alpha, beta]);
    await service.autoScan(now);
    const stored = repo.state().games.find((g) => g.name === "Alpha")!;
    await service.dispatch("removeGame", { id: stored.id });
    expect(libraryNames(repo)).toEqual(["Beta"]);
    await service.autoScan(Date.now() + 48 * hour);
    expect(libraryNames(repo)).toEqual(["Beta"]);
    const result = (await service.dispatch("detectGames", {})) as {
      warnings: string[];
    };
    expect(libraryNames(repo)).toEqual(["Beta"]);
    expect(result.warnings.join(" ")).toMatch(/removed earlier/);
  });

  it("matches the removed path regardless of case, including generic hits inside it", async () => {
    const found = [game("Alpha", "C:\\Games\\Alpha")];
    const { repo, service } = setup(() => Promise.resolve(found));
    await service.dispatch("detectGames", {});
    await service.dispatch("removeGame", { id: repo.state().games[0]!.id });
    found.splice(
      0,
      1,
      game("Alpha", "c:\\games\\ALPHA"),
      game("Alpha helper", "C:\\Games\\Alpha\\Tools", "registry"),
    );
    await service.dispatch("detectGames", {});
    expect(libraryNames(repo)).toEqual([]);
  });

  it("Add game brings a removed game back and scans may keep it", async () => {
    const alpha = game("Alpha", "C:\\Games\\Alpha");
    const readded = {
      ...alpha,
      id: crypto.randomUUID(),
      source: "custom",
    } as Game;
    const { repo, service } = setup([alpha]);
    const desktop = (service as unknown as { desktop: DesktopServices })
      .desktop;
    desktop.pickGame = async () => readded;
    await service.dispatch("detectGames", {});
    await service.dispatch("removeGame", { id: repo.state().games[0]!.id });
    await service.dispatch("addGame", {});
    expect(repo.state().games.map((g) => g.id)).toEqual([readded.id]);
    // Removing it again, then scanning, still keeps it out.
    await service.dispatch("removeGame", { id: readded.id });
    await service.dispatch("detectGames", {});
    expect(libraryNames(repo)).toEqual([]);
  });

  it("survives a game removed while a scan is running", async () => {
    let release = () => {};
    const alpha = game("Alpha", "C:\\Games\\Alpha");
    const { repo, service } = setup(
      () =>
        new Promise((resolve) => {
          release = () => resolve([alpha]);
        }),
    );
    repo.updateState({
      ...repo.state(),
      games: [{ ...alpha, id: crypto.randomUUID() }],
    });
    const scan = service.dispatch("detectGames", {});
    await service.dispatch("removeGame", { id: repo.state().games[0]!.id });
    release();
    await scan;
    expect(libraryNames(repo)).toEqual([]);
  });
});
