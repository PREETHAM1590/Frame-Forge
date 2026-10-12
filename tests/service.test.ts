import { describe, it, expect, vi } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";
import { AppService } from "../electron/service";
describe("validated IPC to SQLite integration", () => {
  it("dispatches persisted workflows and rejects untrusted requests", async () => {
    const repo = new Repository(":memory:");
    const service = new AppService(repo, new MockPlatform(), {
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
    });
    await expect(
      service.dispatch("exec", { command: "cmd" }),
    ).rejects.toThrow();
    await expect(
      service.dispatch("settings", { startup: true }),
    ).rejects.toThrow();
    await service.dispatch("settings", {
      theme: "light",
      startup: false,
      notifications: false,
      diagnostics: false,
    });
    const backup = (await service.dispatch("backup", {
      name: "Test backup",
    })) as { id: string };
    await service.dispatch("settings", {
      theme: "dark",
      startup: false,
      notifications: true,
      diagnostics: false,
    });
    await service.dispatch("restore", { id: backup.id, confirmed: true });
    expect(service.bootstrap().state.settings.theme).toBe("light");
    expect(service.bootstrap().activity.length).toBeGreaterThan(0);
    repo.close();
  });
  it("does not revert committed startup preferences when activity logging fails", async () => {
    const repo = new Repository(":memory:");
    const setStartup = vi.fn();
    const service = new AppService(repo, new MockPlatform(), {
      pickGame: async () => null,
      detectGames: async () => ({
        games: [],
        warnings: [],
        launchers: [],
        perLauncher: [],
      }),
      scanFolder: async () => null,
      setStartup,
      version: "test",
    });
    vi.spyOn(repo, "log").mockImplementation(() => {
      throw new Error("Disk full");
    });
    const settings = {
      ...repo.state().settings,
      startup: true,
      diagnostics: true,
    };
    await expect(service.dispatch("settings", settings)).resolves.toMatchObject(
      { settings },
    );
    expect(repo.state().settings).toEqual(settings);
    expect(setStartup.mock.calls).toEqual([[true]]);
    expect(service.bootstrap().hardware.warnings).toContain(
      "Activity logging failed. Recent actions may be missing from history.",
    );
    await service.refresh();
    expect(service.bootstrap().hardware.warnings).toContain(
      "Activity logging failed. Recent actions may be missing from history.",
    );
    repo.close();
  });
  it("does not report committed configuration restore as failed when logging fails", async () => {
    const repo = new Repository(":memory:");
    const setStartup = vi.fn();
    const service = new AppService(repo, new MockPlatform(), {
      pickGame: async () => null,
      detectGames: async () => ({
        games: [],
        warnings: [],
        launchers: [],
        perLauncher: [],
      }),
      scanFolder: async () => null,
      setStartup,
      version: "test",
    });
    const backup = repo.backup("Original");
    repo.updateState({
      ...repo.state(),
      settings: { ...repo.state().settings, startup: true, theme: "light" },
    });
    vi.spyOn(repo, "log").mockImplementation(() => {
      throw new Error("Disk full");
    });
    await expect(
      service.dispatch("restore", { id: backup.id, confirmed: true }),
    ).resolves.toEqual(backup.state);
    expect(repo.state()).toEqual(backup.state);
    expect(setStartup.mock.calls).toEqual([[false]]);
    expect(repo.backups()).toHaveLength(2);
    repo.close();
  });
  it("still compensates startup when the configuration write fails", async () => {
    const repo = new Repository(":memory:");
    const setStartup = vi.fn();
    const service = new AppService(repo, new MockPlatform(), {
      pickGame: async () => null,
      detectGames: async () => ({
        games: [],
        warnings: [],
        launchers: [],
        perLauncher: [],
      }),
      scanFolder: async () => null,
      setStartup,
      version: "test",
    });
    const previous = repo.state();
    vi.spyOn(repo, "updateState").mockImplementation(() => {
      throw new Error("Configuration failed");
    });
    vi.spyOn(repo, "log").mockImplementation(() => {
      throw new Error("Logging failed");
    });
    await expect(
      service.dispatch("settings", { ...previous.settings, startup: true }),
    ).rejects.toThrow("Configuration failed");
    expect(setStartup.mock.calls).toEqual([[true], [false]]);
    expect(repo.state()).toEqual(previous);
    repo.close();
  });
  it("does not add a folder or registry hit that is inside or above a launcher game already in the library", async () => {
    const repo = new Repository(":memory:");
    const game = (
      name: string,
      path: string,
      source: "riot" | "folder" | "registry",
    ) => ({
      id: crypto.randomUUID(),
      name,
      path,
      source,
      executablePath: null,
      profile: "balanced" as const,
      notes: "",
    });
    const detection = (games: ReturnType<typeof game>[]) => ({
      games,
      warnings: [],
      launchers: ["Riot Games"],
      perLauncher: [],
    });
    let next = detection([
      game("VALORANT", "D:\\Riot Games\\VALORANT\\live", "riot"),
    ]);
    const service = new AppService(repo, new MockPlatform(), {
      pickGame: async () => null,
      detectGames: async () => next,
      scanFolder: async () => next,
      setStartup: () => {},
      version: "test",
    });
    await service.dispatch("detectGames", {});
    next = detection([
      game("VALORANT", "D:\\Riot Games\\VALORANT", "folder"),
      game("Helper", "D:\\Riot Games\\VALORANT\\live\\helper", "registry"),
      game("Riot Client", "D:\\Riot Games\\Riot Client", "folder"),
    ]);
    await service.dispatch("scanFolder", { confirmed: true });
    expect(repo.state().games.map((g) => g.name)).toEqual([
      "VALORANT",
      "Riot Client",
    ]);
    repo.close();
  });
});

describe("rescan source upgrade", () => {
  it("upgrades a library entry first found by the registry or a folder scan to the launcher source", async () => {
    const repo = new Repository(":memory:");
    const game = (
      source: "registry" | "riot",
      executablePath: string | null,
    ) => ({
      id: crypto.randomUUID(),
      name: "VALORANT",
      path: "D:\\Riot Games\\VALORANT\\live",
      source,
      executablePath,
      profile: "gaming" as const,
      notes: "mine",
    });
    let next = [game("registry", null)];
    const service = new AppService(repo, new MockPlatform(), {
      pickGame: async () => null,
      detectGames: async () => ({
        games: next,
        warnings: [],
        launchers: [],
        perLauncher: [],
      }),
      scanFolder: async () => null,
      setStartup: () => {},
      version: "test",
    });
    await service.dispatch("detectGames", {});
    next = [game("riot", "D:\\Riot Games\\VALORANT\\live\\VALORANT.exe")];
    await service.dispatch("detectGames", {});
    expect(repo.state().games).toHaveLength(1);
    expect(repo.state().games[0]).toMatchObject({
      source: "riot",
      executablePath: "D:\\Riot Games\\VALORANT\\live\\VALORANT.exe",
      profile: "gaming",
      notes: "mine",
    });
    repo.close();
  });
});
