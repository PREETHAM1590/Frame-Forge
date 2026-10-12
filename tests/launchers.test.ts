import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  parseBattlenet,
  parseEa,
  parseGamingRoot,
  parseGog,
  parseItchReceipt,
  parseMicrosoftGameConfig,
  parseRiotSettings,
  parseRockstar,
  parseUbisoft,
  parseUninstallHeuristic,
  pickGameExecutable,
  isEpicNonGame,
  isSteamNonGame,
  parseStorePackages,
} from "../electron/launchers.js";
import { decodeRegFile, parseRegExport } from "../electron/registry.js";
import type { RegistryQuery } from "../electron/registry.js";
import { detectInstalledGames, scanGameFolder } from "../electron/games.js";

const fixtures = fileURLToPath(
  new URL("./fixtures/launchers/", import.meta.url),
);
const fixture = (...parts: string[]) =>
  readFile(path.join(fixtures, ...parts), "utf8");
// reg export writes UTF-16LE with a BOM; fixtures go through the same decoding.
const utf16 = (text: string) =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
const records = async (name: string) =>
  parseRegExport(decodeRegFile(utf16(await fixture("registry", name))));

const temporary: string[] = [];
async function tempDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "frameforge-launchers-"));
  temporary.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
function gamingRoot(...names: string[]) {
  const count = Buffer.alloc(4);
  count.writeUInt32LE(names.length);
  return Buffer.concat([
    Buffer.from("RGBX", "latin1"),
    count,
    ...names.map((name) => Buffer.from(`${name}\0`, "utf16le")),
  ]);
}
const none = {
  registry: false as const,
  steamRoots: [],
  epicManifestRoots: [],
  gogGames: [],
  driveRoots: [],
  riotMetadataRoots: [],
  itchRoots: [],
  storePackages: async () => [],
};

describe("reg export parser", () => {
  it("keeps the subkey path, lower-cases value names and converts DWORD", async () => {
    const parsed = await records("ea.reg");
    const game = parsed.find((r) => r.key.endsWith("Battlefield 4"));
    expect(game?.key).toBe(
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Games\\Battlefield 4",
    );
    expect(game?.values).toEqual({
      "install dir": "C:\\Program Files (x86)\\Origin Games\\Battlefield 4\\",
      locale: "en_US",
      version: "42",
    });
  });
  it("handles CRLF, empty values, escaped quotes and hex(2) continuation lines", async () => {
    const parsed = await records("uninstall.reg");
    const cyberpunk = parsed.find((r) => r.key.endsWith("\\Cyberpunk"));
    expect(cyberpunk?.values.uninstallstring).toBe("%ProgramFiles%\\x.exe");
    expect(cyberpunk?.values.nomodify).toBe("1");
    expect(
      parseRegExport(
        'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\SOFTWARE\\Test]\r\n"Empty"=""\r\n"Quoted"="say \\"hi\\""\r\n',
      ),
    ).toEqual([
      {
        key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Test",
        values: { empty: "", quoted: 'say "hi"' },
      },
    ]);
  });
  it("decodes UTF-16LE exports so non-ASCII names and paths survive (reg query would garble them)", async () => {
    const text =
      'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\SOFTWARE\\Test\\Café Игры 日本語]\r\n"InstallLocation"="D:\\\\Игры\\\\Café"\r\n';
    const [record] = parseRegExport(decodeRegFile(utf16(text)));
    expect(record?.key.endsWith("Café Игры 日本語")).toBe(true);
    expect(record?.values.installlocation).toBe("D:\\Игры\\Café");
  });
});

describe(".GamingRoot parser", () => {
  it("reads the RGBX header, count and UTF-16LE folder names", () => {
    expect(parseGamingRoot(gamingRoot("XboxGames"))).toEqual(["XboxGames"]);
    expect(parseGamingRoot(gamingRoot("XboxGames", "Games\\Xbox"))).toEqual([
      "XboxGames",
      "Games\\Xbox",
    ]);
  });
  it("rejects bad magic and folder names that escape the drive", () => {
    expect(parseGamingRoot(Buffer.from("nope nope nope"))).toEqual([]);
    expect(parseGamingRoot(gamingRoot("..\\Windows", "C:\\Temp"))).toEqual([]);
  });
});

describe("MicrosoftGame.config parser", () => {
  it("reads attributes that span several lines (real Roblox file)", async () => {
    expect(
      parseMicrosoftGameConfig(
        await fixture("xbox", "Roblox.MicrosoftGame.config"),
        "Folder",
      ),
    ).toEqual({ name: "Roblox", executable: "RobloxPlayerBeta.exe" });
  });
  it("falls back to the folder name for ms-resource titles and takes the first executable", async () => {
    expect(
      parseMicrosoftGameConfig(
        await fixture("xbox", "Localized.MicrosoftGame.config"),
        "Contoso Quest",
      ),
    ).toEqual({ name: "Contoso Quest", executable: "Localized.exe" });
  });
  it("tolerates a config without executables", () => {
    expect(parseMicrosoftGameConfig("<Game/>", "Only Folder")).toEqual({
      name: "Only Folder",
    });
  });
});

describe("Riot product settings parser", () => {
  it("maps a live product to its friendly name and forward-slash path", async () => {
    expect(
      parseRiotSettings(
        await fixture("riot", "valorant.live.product_settings.yaml"),
        "valorant.live",
      ),
    ).toEqual({ name: "VALORANT", installPath: "D:/Riot Games/VALORANT/live" });
  });
  it("labels the PBE patchline", async () => {
    expect(
      parseRiotSettings(
        await fixture("riot", "league_of_legends.pbe.product_settings.yaml"),
        "league_of_legends.pbe",
      ),
    ).toEqual({
      name: "League of Legends (PBE)",
      installPath: "D:/Riot Games/League of Legends (PBE)",
    });
  });
  it("skips settings without an install line and title-cases unknown products", async () => {
    expect(
      parseRiotSettings(
        await fixture("riot", "Riot-Client.settings.yaml"),
        "Riot Client",
      ),
    ).toBeNull();
    expect(
      parseRiotSettings(
        'product_install_full_path: "D:/Riot Games/X"',
        "new_game.live",
      )?.name,
    ).toBe("New Game");
  });
});

describe("itch receipt parser", () => {
  it("reads the game title from a gzip receipt", () => {
    const receipt = gzipSync(JSON.stringify({ game: { title: " Celeste " } }));
    expect(parseItchReceipt(receipt)).toBe("Celeste");
    expect(parseItchReceipt(gzipSync("{}"))).toBeNull();
  });
  it("rejects oversized receipts and decompression bombs", () => {
    expect(() => parseItchReceipt(Buffer.alloc(1024 * 1024 + 1))).toThrow();
    expect(() =>
      parseItchReceipt(gzipSync(Buffer.alloc(4 * 1024 * 1024, 32))),
    ).toThrow();
  });
});

describe("registry based parsers", () => {
  it("EA: names come from the subkey leaf and EA infrastructure is ignored", async () => {
    expect(parseEa(await records("ea.reg"))).toEqual([
      {
        name: "Battlefield 4",
        installPath: "C:\\Program Files (x86)\\Origin Games\\Battlefield 4\\",
      },
    ]);
  });
  it("Ubisoft: uses the Uplay Install display name, else the folder basename", async () => {
    expect(
      parseUbisoft(
        await records("ubisoft.reg"),
        await records("uninstall.reg"),
      ),
    ).toEqual([
      {
        name: "Far Cry 5",
        installPath:
          "C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Far Cry 5/",
      },
      {
        name: "Trials Rising",
        installPath:
          "C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Trials Rising/",
      },
    ]);
  });
  it("Rockstar: excludes Launcher and Social Club", async () => {
    expect(
      parseRockstar(
        await records("rockstar.reg"),
        await records("uninstall.reg"),
      ),
    ).toEqual([
      {
        name: "Grand Theft Auto V",
        installPath: "C:\\Program Files\\Rockstar Games\\Grand Theft Auto V",
      },
    ]);
  });
  it("Battle.net: Blizzard games only, not the app", async () => {
    expect(parseBattlenet(await records("uninstall.reg"))).toEqual([
      {
        name: "Overwatch 2",
        installPath: "C:\\Program Files (x86)\\Overwatch",
      },
    ]);
  });
  it("GOG: name, path and unquoted exe", async () => {
    expect(parseGog(await records("gog.reg"))).toEqual([
      {
        name: "The Witcher 3",
        installPath: "C:\\GOG Games\\Witcher 3",
        executable: "C:\\GOG Games\\Witcher 3\\bin\\witcher3.exe",
      },
    ]);
  });
  it("Uninstall heuristic: allowlisted publishers and Steam App keys, never launchers or other vendors", async () => {
    const names = parseUninstallHeuristic(await records("uninstall.reg")).map(
      (game) => game.name,
    );
    expect(names).toEqual([
      "Overwatch 2",
      "The Outlast Trials",
      "Cyberpunk 2077",
    ]);
  });
});

describe("store specific filters", () => {
  it("skips Steam redistributables and Epic plugins/engines", () => {
    expect(isSteamNonGame("228980", "Steamworks Common Redistributables")).toBe(
      true,
    );
    expect(isSteamNonGame("1493710", "Proton Experimental")).toBe(true);
    expect(isSteamNonGame("1628350", "Steam Linux Runtime 3.0 (sniper)")).toBe(
      true,
    );
    expect(isSteamNonGame("1304930", "The Outlast Trials")).toBe(false);
    expect(isEpicNonGame(["public", "engines"])).toBe(true);
    expect(isEpicNonGame(["plugins/engine"])).toBe(true);
    expect(isEpicNonGame(["public", "games", "applications"])).toBe(false);
  });
  it("picks the largest executable that is not a helper", () => {
    expect(
      pickGameExecutable([
        { file: "C:\\G\\unins000.exe", size: 9000 },
        { file: "C:\\G\\UnityCrashHandler64.exe", size: 8000 },
        { file: "C:\\G\\EasyAntiCheat_EOS_Setup.exe", size: 7000 },
        { file: "C:\\G\\bin\\game.exe", size: 500 },
        { file: "C:\\G\\small.exe", size: 100 },
        { file: "C:\\G\\readme.txt", size: 99999 },
      ]),
    ).toBe("C:\\G\\bin\\game.exe");
    expect(
      pickGameExecutable([{ file: "C:\\G\\setup.exe", size: 1 }]),
    ).toBeUndefined();
  });
});

function fakeRegistry(table: Record<string, string>): RegistryQuery {
  return async (key) => {
    const text = table[key];
    return text ? parseRegExport(text) : [];
  };
}
const uninstallKey =
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
function reg(key: string, values: Record<string, string>) {
  const escape = (text: string) =>
    text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `\n[HKEY_LOCAL_MACHINE\\${key}]\n${Object.entries(values)
    .map(([name, value]) => `"${escape(name)}"="${escape(value)}"`)
    .join("\n")}\n`;
}

describe("detection across launchers", () => {
  it("finds Xbox games from .GamingRoot, resolves the executable and ignores folders without a config", async () => {
    const drive = await tempDir();
    await writeFile(path.join(drive, ".GamingRoot"), gamingRoot("XboxGames"));
    const content = path.join(drive, "XboxGames", "Roblox", "Content");
    await mkdir(content, { recursive: true });
    await mkdir(path.join(drive, "XboxGames", "GameSave", "pgs"), {
      recursive: true,
    });
    await writeFile(
      path.join(content, "MicrosoftGame.config"),
      await fixture("xbox", "Roblox.MicrosoftGame.config"),
    );
    await writeFile(path.join(content, "RobloxPlayerBeta.exe"), "exe");
    const result = await detectInstalledGames({
      ...none,
      driveRoots: [drive],
    });
    expect(result.games).toHaveLength(1);
    expect(result.games[0]).toMatchObject({
      name: "Roblox",
      source: "xbox",
      path: path.join(drive, "XboxGames", "Roblox"),
      executablePath: path.join(content, "RobloxPlayerBeta.exe"),
    });
    expect(result.warnings).toEqual([]);
    expect(result.perLauncher.find((l) => l.launcher === "Xbox app")).toEqual({
      launcher: "Xbox app",
      found: 1,
      skipped: 0,
      status: "scanned",
    });
  });
  it("falls back to X:\\XboxGames when there is no .GamingRoot", async () => {
    const drive = await tempDir();
    const content = path.join(drive, "XboxGames", "Localized", "Content");
    await mkdir(content, { recursive: true });
    await writeFile(
      path.join(content, "MicrosoftGame.config"),
      await fixture("xbox", "Localized.MicrosoftGame.config"),
    );
    const result = await detectInstalledGames({ ...none, driveRoots: [drive] });
    expect(result.games).toHaveLength(1);
    expect(result.games[0]).toMatchObject({
      name: "Localized",
      executablePath: null,
    });
    expect(result.warnings).toEqual([]);
  });
  it("keeps an Xbox game but drops an executable that escapes its folder", async () => {
    const drive = await tempDir();
    await writeFile(path.join(drive, ".GamingRoot"), gamingRoot("XboxGames"));
    const content = path.join(drive, "XboxGames", "Evil", "Content");
    await mkdir(content, { recursive: true });
    await writeFile(path.join(drive, "outside.exe"), "exe");
    await writeFile(
      path.join(content, "MicrosoftGame.config"),
      '<Game><ExecutableList><Executable Name="..\\..\\..\\outside.exe"/></ExecutableList><ShellVisuals DefaultDisplayName="Evil Game"/></Game>',
    );
    const result = await detectInstalledGames({ ...none, driveRoots: [drive] });
    expect(result.games).toHaveLength(1);
    expect(result.games[0]?.executablePath).toBeNull();
  });
  it("reads Riot installs, skips products without an install line and missing folders, and deduplicates", async () => {
    const root = await tempDir();
    const metadata = path.join(root, "Metadata");
    const valorant = path.join(root, "VALORANT", "live");
    await mkdir(valorant, { recursive: true });
    const yaml = (folder: string, install: string) =>
      writeFile(
        path.join(metadata, folder, `${folder}.product_settings.yaml`),
        `product_install_full_path: "${install.replaceAll("\\", "/")}"\n`,
      );
    for (const folder of [
      "valorant.live",
      "teamfighttactics.live",
      "Riot Client",
      "lion.live",
    ])
      await mkdir(path.join(metadata, folder), { recursive: true });
    await yaml("valorant.live", valorant);
    await yaml("teamfighttactics.live", path.join(root, "Missing TFT"));
    await writeFile(
      path.join(metadata, "Riot Client", "Riot Client.product_settings.yaml"),
      "settings:\n    x: 1\n",
    );
    const result = await detectInstalledGames({
      ...none,
      riotMetadataRoots: [metadata],
      registry: undefined,
      queryRegistry: fakeRegistry({
        [uninstallKey]:
          reg(`${uninstallKey.slice(5)}\\Riot Game valorant.live`, {
            DisplayName: "VALORANT",
            Publisher: "Riot Games, Inc",
            InstallLocation: valorant.replaceAll("\\", "/").toUpperCase(),
          }) +
          reg(`${uninstallKey.slice(5)}\\Helper`, {
            DisplayName: "Valorant Helper",
            Publisher: "Riot Games, Inc",
            InstallLocation: path.join(valorant, "helper"),
          }),
      }),
    });
    expect(result.games.map((g) => [g.name, g.source])).toEqual([
      ["VALORANT", "riot"],
    ]);
    expect(
      result.perLauncher.find((l) => l.launcher === "Riot Games"),
    ).toMatchObject({
      found: 1,
      status: "scanned",
    });
  });
  it("reads itch receipts and uses the app folder as the install", async () => {
    const apps = await tempDir();
    await mkdir(path.join(apps, "celeste", ".itch"), { recursive: true });
    await mkdir(path.join(apps, "no-receipt"), { recursive: true });
    await mkdir(path.join(apps, "broken", ".itch"), { recursive: true });
    await writeFile(
      path.join(apps, "celeste", ".itch", "receipt.json.gz"),
      gzipSync(JSON.stringify({ game: { title: "Celeste" } })),
    );
    await writeFile(
      path.join(apps, "broken", ".itch", "receipt.json.gz"),
      "not gzip",
    );
    const result = await detectInstalledGames({ ...none, itchRoots: [apps] });
    expect(result.games).toHaveLength(1);
    expect(result.games[0]).toMatchObject({
      name: "Celeste",
      source: "itch",
      path: path.join(apps, "celeste"),
      executablePath: null,
    });
    expect(result.warnings).toContain(
      "itch.io: skipped 1 invalid installation metadata record(s).",
    );
  });
  it("collects EA, Ubisoft, Rockstar, Battle.net and registry games and dedupes by install path across sources", async () => {
    const root = await tempDir();
    const dirs = {
      bf4: path.join(root, "Origin Games", "Battlefield 4"),
      fc5: path.join(root, "games", "Far Cry 5"),
      gta: path.join(root, "Rockstar Games", "Grand Theft Auto V"),
      ow: path.join(root, "Overwatch"),
      steam: path.join(root, "steamapps", "common", "Outlast"),
      cp: path.join(root, "Cyberpunk 2077"),
    };
    for (const dir of Object.values(dirs))
      await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(root, "steamapps", "appmanifest_1304930.acf"),
      '"AppState"\n{\n\t"appid"\t\t"1304930"\n\t"name"\t\t"The Outlast Trials"\n\t"installdir"\t\t"Outlast"\n\t"StateFlags"\t\t"4"\n}\n',
    );
    const fwd = (value: string) => value.replaceAll("\\", "/");
    const ea = "HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts";
    const rockstar = "HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games";
    const ubisoft = "HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs";
    const u = uninstallKey.slice(5);
    const result = await detectInstalledGames({
      ...none,
      steamRoots: [root],
      registry: undefined,
      queryRegistry: fakeRegistry({
        [ea]: reg(`${ea.slice(5)}\\EA Games\\Battlefield 4`, {
          "Install Dir": dirs.bf4,
        }),
        [ubisoft]: reg(`${ubisoft.slice(5)}\\720`, {
          InstallDir: fwd(dirs.fc5) + "/",
        }),
        [rockstar]: reg(`${rockstar.slice(5)}\\Grand Theft Auto V`, {
          InstallFolder: dirs.gta,
        }),
        [uninstallKey]:
          reg(`${u}\\Uplay Install 720`, { DisplayName: "Far Cry 5" }) +
          reg(`${u}\\Overwatch`, {
            DisplayName: "Overwatch 2",
            Publisher: "Blizzard Entertainment",
            InstallLocation: dirs.ow,
          }) +
          reg(`${u}\\Steam App 1304930`, {
            DisplayName: "The Outlast Trials (registry copy)",
            InstallLocation: dirs.steam.toUpperCase(),
          }) +
          reg(`${u}\\Cyberpunk`, {
            DisplayName: "Cyberpunk 2077",
            Publisher: "CD PROJEKT RED",
            InstallLocation: dirs.cp,
          }) +
          reg(`${u}\\Ow`, {
            DisplayName: "Overwatch 2 again",
            Publisher: "Blizzard Entertainment",
            InstallLocation: dirs.ow,
          }),
      }),
    });
    expect(result.games.map((g) => [g.name, g.source]).sort()).toEqual(
      [
        ["Battlefield 4", "ea"],
        ["Far Cry 5", "ubisoft"],
        ["Grand Theft Auto V", "rockstar"],
        ["Overwatch 2", "battlenet"],
        ["The Outlast Trials", "steam"],
        ["Cyberpunk 2077", "registry"],
      ].sort(),
    );
    const found = Object.fromEntries(
      result.perLauncher.map((l) => [l.launcher, l.found]),
    );
    expect(found).toMatchObject({
      Steam: 1,
      "EA app": 1,
      "Ubisoft Connect": 1,
      "Battle.net": 1,
      "Rockstar Games": 1,
      "Other installed games": 1,
    });
    expect(new Set(result.games.map((g) => g.path.toLowerCase())).size).toBe(
      result.games.length,
    );
  });
  it("rejects relative and network install paths from metadata and counts them as skipped", async () => {
    const ea = "HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts";
    const result = await detectInstalledGames({
      ...none,
      registry: undefined,
      queryRegistry: fakeRegistry({
        [ea]:
          reg(`${ea.slice(5)}\\EA Games\\Relative`, {
            "Install Dir": "games\\relative",
          }) +
          reg(`${ea.slice(5)}\\EA Games\\Network`, {
            "Install Dir": "\\\\server\\share\\game",
          }),
      }),
    });
    expect(result.games).toEqual([]);
    expect(result.warnings).toContain(
      "EA app: skipped 2 invalid installation metadata record(s).",
    );
  });
  it("rejects oversized metadata files", async () => {
    const root = await tempDir();
    const metadata = path.join(root, "Metadata", "valorant.live");
    const install = path.join(root, "Game");
    await mkdir(metadata, { recursive: true });
    await mkdir(install);
    await writeFile(
      path.join(metadata, "valorant.live.product_settings.yaml"),
      `product_install_full_path: "${install.replaceAll("\\", "/")}"\n` +
        "#".repeat(1024 * 1024 + 1),
    );
    const result = await detectInstalledGames({
      ...none,
      riotMetadataRoots: [path.join(root, "Metadata")],
    });
    expect(result.games).toEqual([]);
    expect(result.warnings).toContain(
      "Riot Games: skipped 1 invalid installation metadata record(s).",
    );
  });
  it("reports found, not installed and failed sources and emits one progress event per source", async () => {
    const ea = "HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts";
    const events: {
      launcher: string;
      done: number;
      total: number;
      found: number;
    }[] = [];
    const result = await detectInstalledGames(
      {
        ...none,
        registry: undefined,
        queryRegistry: async (key) => {
          if (key === ea) throw new Error("reg.exe timed out");
          return [];
        },
      },
      (event) => events.push(event),
    );
    const status = Object.fromEntries(
      result.perLauncher.map((l) => [l.launcher, l.status]),
    );
    expect(status["EA app"]).toBe("error");
    expect(status["Steam"]).toBe("not-installed");
    expect(result.warnings).toContain("EA app could not be scanned.");
    expect(result.launchers).toEqual([]);
    expect(events).toHaveLength(result.perLauncher.length);
    expect(events.map((e) => e.done)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(events.at(-1)).toMatchObject({
      done: events.length,
      total: events.length,
    });
  });
});

describe("folder scan", () => {
  it("picks the largest non-helper executable up to depth 3 and ignores folders without games", async () => {
    const root = await tempDir();
    const game = path.join(root, "My Game");
    await mkdir(path.join(game, "bin", "x64"), { recursive: true });
    await mkdir(path.join(root, "Docs"), { recursive: true });
    await mkdir(path.join(root, "Installer Only"), { recursive: true });
    await mkdir(path.join(game, "a", "b", "c", "d"), { recursive: true });
    await writeFile(path.join(game, "unins000.exe"), Buffer.alloc(5000));
    await writeFile(
      path.join(game, "bin", "x64", "game.exe"),
      Buffer.alloc(2000),
    );
    await writeFile(
      path.join(game, "a", "b", "c", "d", "deep.exe"),
      Buffer.alloc(9000),
    );
    await writeFile(path.join(root, "Installer Only", "setup.exe"), "x");
    await writeFile(path.join(root, "Docs", "readme.txt"), "x");
    const result = await scanGameFolder(root);
    expect(result.games).toHaveLength(1);
    expect(result.games[0]).toMatchObject({
      name: "My Game",
      source: "folder",
      path: game,
      executablePath: path.join(game, "bin", "x64", "game.exe"),
    });
    expect(result.perLauncher).toEqual([
      { launcher: "Chosen folder", found: 1, skipped: 0, status: "scanned" },
    ]);
  });
  it("rejects a network folder", async () => {
    await expect(scanGameFolder("\\\\server\\share")).rejects.toThrow();
  });
});

describe("degraded and extended detection", () => {
  it("keeps Epic and GOG games whose executable is missing, not an exe or escaping the install", async () => {
    const root = await tempDir();
    const manifests = path.join(root, "Manifests");
    await mkdir(manifests);
    const installs = ["a", "b", "c", "d"].map((name) => path.join(root, name));
    for (const install of installs) await mkdir(install);
    await writeFile(path.join(root, "outside.exe"), "x");
    await writeFile(path.join(installs[1]!, "readme.txt"), "x");
    const launches = ["missing.exe", "readme.txt", "../outside.exe"];
    for (const [index, launch] of launches.entries())
      await writeFile(
        path.join(manifests, `${index}.item`),
        JSON.stringify({
          DisplayName: `Epic ${index}`,
          InstallLocation: installs[index],
          LaunchExecutable: launch,
        }),
      );
    const result = await detectInstalledGames({
      ...none,
      epicManifestRoots: [manifests],
      gogGames: [
        { name: "GOG Game", path: installs[3]!, executablePath: "nope.exe" },
      ],
    });
    expect(result.games.map((g) => [g.name, g.executablePath])).toEqual([
      ["Epic 0", null],
      ["Epic 1", null],
      ["Epic 2", null],
      ["GOG Game", null],
    ]);
    expect(result.warnings).toEqual([]);
  });
  it("finds games with non-ASCII names and paths from a UTF-16 registry export", async () => {
    const root = await tempDir();
    const install = path.join(root, "Игры", "Café");
    await mkdir(install, { recursive: true });
    const ea = "HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts";
    const result = await detectInstalledGames({
      ...none,
      registry: undefined,
      queryRegistry: async (key) =>
        key === ea
          ? parseRegExport(
              decodeRegFile(
                utf16(
                  reg(`${ea.slice(5)}\\EA Games\\Café Игры`, {
                    "Install Dir": install,
                  }),
                ),
              ),
            )
          : [],
    });
    expect(result.games).toHaveLength(1);
    expect(result.games[0]).toMatchObject({ name: "Café Игры", path: install });
  });
  it("lists installed Microsoft Store game packages and drops one nested in an Xbox folder", async () => {
    const root = await tempDir();
    const forza = path.join(root, "WindowsApps", "Forza_1.0_x64__abc");
    await mkdir(forza, { recursive: true });
    await writeFile(path.join(forza, "Forza.exe"), "exe");
    await writeFile(
      path.join(forza, "MicrosoftGame.config"),
      '<Game><ExecutableList><Executable Name="Forza.exe"/></ExecutableList><ShellVisuals DefaultDisplayName="ms-resource:Name"/></Game>',
    );
    const drive = await tempDir();
    await writeFile(path.join(drive, ".GamingRoot"), gamingRoot("XboxGames"));
    const roblox = path.join(drive, "XboxGames", "Roblox");
    await mkdir(path.join(roblox, "Content"), { recursive: true });
    await writeFile(
      path.join(roblox, "Content", "MicrosoftGame.config"),
      await fixture("xbox", "Roblox.MicrosoftGame.config"),
    );
    const result = await detectInstalledGames({
      ...none,
      driveRoots: [drive],
      storePackages: async () => [
        { name: "Forza Horizon", installLocation: forza },
        { name: "Roblox", installLocation: path.join(roblox, "Content") },
      ],
    });
    expect(result.games.map((g) => [g.name, g.source]).sort()).toEqual([
      ["Forza Horizon", "msstore"],
      ["Roblox", "xbox"],
    ]);
    expect(
      result.games.find((g) => g.source === "msstore")?.executablePath,
    ).toBe(path.join(forza, "Forza.exe"));
    expect(
      result.perLauncher.find((l) => l.launcher === "Microsoft Store"),
    ).toEqual({
      launcher: "Microsoft Store",
      found: 1,
      skipped: 0,
      status: "scanned",
    });
  });
  it("parses the Store package script output (array, single object, empty)", () => {
    expect(parseStorePackages("")).toEqual([]);
    expect(parseStorePackages('{"name":"A","installLocation":"C:/x"}')).toEqual(
      [{ name: "A", installLocation: "C:/x" }],
    );
    expect(
      parseStorePackages(
        '[{"name":null,"installLocation":"C:/y"},{"name":"B"}]',
      ),
    ).toEqual([{ name: null, installLocation: "C:/y" }]);
  });
  it("warns when a source or the whole library is truncated", async () => {
    const root = await tempDir();
    const apps = path.join(root, "apps");
    await mkdir(apps);
    const installs: string[] = [];
    for (let index = 0; index < 501; index++) {
      const install = path.join(root, `g${index}`);
      await mkdir(install);
      installs.push(install);
    }
    await mkdir(path.join(apps, "extra", ".itch"), { recursive: true });
    await writeFile(
      path.join(apps, "extra", ".itch", "receipt.json.gz"),
      gzipSync(JSON.stringify({ game: { title: "Extra" } })),
    );
    const result = await detectInstalledGames({
      ...none,
      gogGames: installs.map((install, index) => ({
        name: `Game ${index}`,
        path: install,
      })),
      itchRoots: [apps],
    });
    expect(result.games).toHaveLength(500);
    expect(result.warnings).toContain(
      "GOG: only the first 500 entries were scanned.",
    );
    expect(result.warnings).toContain(
      "The library holds at most 500 games; 1 more were not added.",
    );
  });
  it("reports a launcher that is present but has no games as scanned with zero found", async () => {
    const u =
      "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    const result = await detectInstalledGames({
      ...none,
      registry: undefined,
      queryRegistry: fakeRegistry({
        [u]: reg(`${u.slice(5)}\\Battle.net`, {
          DisplayName: "Battle.net",
          Publisher: "Blizzard Entertainment",
          InstallLocation: "C:/Program Files (x86)/Battle.net",
        }),
      }),
    });
    expect(
      result.perLauncher.find((l) => l.launcher === "Battle.net"),
    ).toMatchObject({ found: 0, status: "scanned" });
  });
});
