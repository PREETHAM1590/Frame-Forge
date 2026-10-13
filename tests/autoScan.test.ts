import { describe, it, expect, vi } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";
import { AppService, type DesktopServices } from "../electron/service";
import {
  dismissGame,
  type Dismissed,
  lastScanKey,
  maxDismissed,
  partialScanKey,
  shouldAutoScan,
  undismissPaths,
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

describe("shouldAutoScan after a partial scan", () => {
  it("retries after an hour instead of the full interval", () => {
    const at = (h: number) => new Date(now - h * hour).toISOString();
    expect(shouldAutoScan(at(0.5), on, now, true)).toBe(false);
    expect(shouldAutoScan(at(1), on, now, true)).toBe(true);
    expect(shouldAutoScan(at(1), on, now, false)).toBe(false);
  });
});

const entry = (path: string, name = "G") => ({
  name,
  path,
  source: "steam" as const,
  executablePath: null,
});
describe("dismissed list", () => {
  it("keeps one entry per path (any case), newest last, capped", () => {
    expect(
      dismissGame([entry("c:\\a"), entry("C:\\B")], entry("C:\\A")).map(
        (x) => x.path,
      ),
    ).toEqual(["C:\\B", "C:\\A"]);
    const full = Array.from({ length: maxDismissed }, (_, i) =>
      entry(`c:\\g${i}`),
    );
    const next = dismissGame(full, entry("C:\\new"));
    expect(next).toHaveLength(maxDismissed);
    expect(next.at(-1)?.path).toBe("C:\\new");
    expect(next[0]?.path).toBe("c:\\g1");
  });
  const list = [
    entry("C:\\Games\\Alpha"),
    entry("C:\\Games\\Alpha\\Binaries\\Win64"),
    entry("C:\\Games\\Alphabet"),
    entry("D:\\Other"),
  ];
  const paths = (l: Dismissed[]) => l.map((x) => x.path);
  it("hand-picked games clear only entries equal to or above the picked folder", () => {
    expect(paths(undismissPaths(list, ["c:\\games\\alpha\\binaries"]))).toEqual(
      ["C:\\Games\\Alpha\\Binaries\\Win64", "C:\\Games\\Alphabet", "D:\\Other"],
    );
    // Adding C:\Games\Foo.exe must not bring back everything under C:\Games.
    expect(undismissPaths(list, ["C:\\Games"])).toEqual(list);
    expect(undismissPaths(list, [])).toEqual(list);
  });
  it("a folder scan also clears entries below the folder", () => {
    expect(paths(undismissPaths(list, ["C:\\Games\\Alpha"], "both"))).toEqual([
      "C:\\Games\\Alphabet",
      "D:\\Other",
    ]);
    expect(paths(undismissPaths(list, ["C:\\Games"], "both"))).toEqual([
      "D:\\Other",
    ]);
  });
  it("never matches a bare drive root, on either side", () => {
    expect(undismissPaths(list, ["C:\\"], "both")).toEqual(list);
    expect(undismissPaths(list, ["D:/"], "both")).toEqual(list);
    const rooted = [entry("C:\\"), entry("C:\\Games\\Alpha")];
    expect(paths(undismissPaths(rooted, ["C:\\Games\\Alpha\\Bin"]))).toEqual([
      "C:\\",
    ]);
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

  it("Add game un-removes the game even when its folder differs from the scanner's install root", async () => {
    const alpha = game("Alpha", "C:\\Games\\Alpha");
    // pickGame uses dirname(exe), which is deeper than the Steam install folder.
    const exe = "C:\\Games\\Alpha\\Binaries\\Win64\\Alpha.exe";
    const picked = {
      ...alpha,
      id: crypto.randomUUID(),
      name: "Picked",
      path: "C:\\Games\\Alpha\\Binaries\\Win64",
      executablePath: exe,
      source: "custom",
    } as Game;
    const { repo, service } = setup([alpha]);
    const desktop = (service as unknown as { desktop: DesktopServices })
      .desktop;
    desktop.pickGame = async () => picked;
    await service.dispatch("detectGames", {});
    await service.dispatch("removeGame", { id: repo.state().games[0]!.id });
    expect(service.bootstrap().removedGames).toHaveLength(1);
    await service.dispatch("addGame", {});
    expect(service.bootstrap().removedGames).toEqual([]);
    // It is no longer skipped: the next scan lists the scanner's own entry again.
    await service.dispatch("detectGames", {});
    expect(libraryNames(repo)).toContain("Alpha");
  });

  it("lists removed games and restores one with its source and path", async () => {
    const alpha = game("Alpha", "C:\\Games\\Alpha");
    const { repo, service } = setup([alpha, game("Beta", "C:\\Games\\Beta")]);
    await service.dispatch("detectGames", {});
    await service.dispatch("removeGame", { id: repo.state().games[0]!.id });
    expect(service.bootstrap().removedGames).toEqual([
      { name: "Alpha", path: "C:\\Games\\Alpha", source: "steam" },
    ]);
    await service.dispatch("restoreGame", { path: "c:\\games\\ALPHA" });
    expect(libraryNames(repo).sort()).toEqual(["Alpha", "Beta"]);
    expect(repo.state().games.find((g) => g.name === "Alpha")).toMatchObject({
      source: "steam",
      boostMode: "global",
    });
    expect(service.bootstrap().removedGames).toEqual([]);
    await expect(
      service.dispatch("restoreGame", { path: "C:\\Games\\Alpha" }),
    ).rejects.toThrow(/not in the removed list/);
    // It is no longer skipped by scans.
    await service.dispatch("detectGames", {});
    expect(libraryNames(repo)).toHaveLength(2);
  });

  it("Scan a folder re-adds removed games it finds", async () => {
    const alpha = game("Alpha", "C:\\Games\\Alpha");
    const { repo, service } = setup([alpha]);
    await service.dispatch("detectGames", {});
    await service.dispatch("removeGame", { id: repo.state().games[0]!.id });
    const desktop = (service as unknown as { desktop: DesktopServices })
      .desktop;
    desktop.scanFolder = async () => ({
      games: [alpha],
      warnings: [],
      launchers: [],
      perLauncher: [],
    });
    await service.dispatch("scanFolder", { confirmed: true });
    expect(libraryNames(repo)).toEqual(["Alpha"]);
    expect(service.bootstrap().removedGames).toEqual([]);
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

describe("scan bookkeeping", () => {
  const desktopOf = (service: AppService) =>
    (service as unknown as { desktop: DesktopServices }).desktop;

  it("marks a scan whose source failed as partial and retries within the hour", async () => {
    const { repo, service } = setup([]);
    const detectGames = vi.fn(async () => ({
      games: [],
      warnings: ["Steam could not be read."],
      launchers: [],
      perLauncher: [
        {
          launcher: "Steam",
          found: 0,
          skipped: 0,
          status: "error" as const,
        },
      ],
    }));
    desktopOf(service).detectGames = detectGames;
    await service.autoScan(Date.now());
    expect(repo.meta(partialScanKey)).toBe(true);
    await service.autoScan(Date.now() + 30 * 60_000);
    expect(detectGames).toHaveBeenCalledTimes(1);
    await service.autoScan(Date.now() + 61 * 60_000);
    expect(detectGames).toHaveBeenCalledTimes(2);
  });

  it("an informational warning alone does not make a scan partial", async () => {
    const { repo, service } = setup([]);
    desktopOf(service).detectGames = async () => ({
      games: [],
      warnings: ["A Steam library could not be scanned."],
      launchers: ["Steam"],
      perLauncher: [
        { launcher: "Steam", found: 0, skipped: 1, status: "scanned" as const },
      ],
    });
    await service.autoScan(Date.now());
    expect(repo.meta(partialScanKey)).toBe(false);
  });

  it("Add game of a file in a shared folder does not bring back other removed games there", async () => {
    const { repo, service } = setup([
      game("Foo", "C:\\Games\\Foo"),
      game("Bar", "C:\\Games\\Bar"),
    ]);
    await service.dispatch("detectGames", {});
    for (const g of repo.state().games)
      await service.dispatch("removeGame", { id: g.id });
    expect(service.bootstrap().removedGames).toHaveLength(2);
    desktopOf(service).pickGame = async () =>
      ({
        ...game("Picked", "C:\\Games"),
        source: "custom",
        executablePath: "C:\\Games\\Picked.exe",
      }) as Game;
    await service.dispatch("addGame", {});
    expect(service.bootstrap().removedGames).toHaveLength(2);
  });

  it("a clean scan clears the partial mark", async () => {
    const { repo, service } = setup([]);
    repo.setMeta(partialScanKey, true);
    await service.autoScan(Date.now());
    expect(repo.meta(partialScanKey)).toBe(false);
  });

  it("reports a manual Rescan that joins a startup scan as manual", async () => {
    let release = () => {};
    const { repo, service, events } = setup(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const auto = service.autoScan(Date.now());
    const manual = service.dispatch("detectGames", {});
    await Promise.resolve();
    release();
    await Promise.all([auto, manual]);
    expect(events.at(-1)).toMatchObject({ phase: "finished", auto: false });
    expect(repo.activity()[0]?.label).toBe("Installed game scan completed");
  });

  it("asks the icon cache to prune after a scan", async () => {
    const { service } = setup([game("Alpha", "C:\\Games\\Alpha")]);
    const prune = vi.fn<(games: Game[]) => Promise<void>>(async () => {});
    desktopOf(service).pruneIcons = prune;
    await service.dispatch("detectGames", {});
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune.mock.calls[0]?.[0]).toHaveLength(1);
  });
});
