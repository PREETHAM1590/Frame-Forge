import { readFile, readdir, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "@node-steam/vdf";
import { z } from "zod";
import {
  sourceLabels,
  type Detection,
  type Game,
} from "../shared/contracts.js";
import {
  queryRegistry,
  type RegistryQuery,
  type RegistryRecord,
} from "./registry.js";
import * as launcher from "./launchers.js";
import type { Found } from "./launchers.js";

export async function safeExecutable(input: string): Promise<string> {
  if (
    !path.isAbsolute(input) ||
    input.startsWith("\\\\") ||
    input.length > 2048 ||
    path.extname(input).toLowerCase() !== ".exe"
  )
    throw new Error("Choose a local Windows executable.");
  const resolved = await realpath(input);
  if (
    resolved.startsWith("\\\\") ||
    path.extname(resolved).toLowerCase() !== ".exe" ||
    !(await stat(resolved)).isFile()
  )
    throw new Error("Choose an existing local executable.");
  return resolved;
}
async function readText(file: string): Promise<string> {
  if ((await stat(file)).size > launcher.maxMetadataBytes)
    throw new Error("Metadata file too large");
  return readFile(file, "utf8");
}
async function readVdf(file: string): Promise<unknown> {
  return parse(await readText(file)) as unknown;
}
type GogInstall = { name: string; path: string; executablePath?: string };
export type DetectionOptions = {
  /** `false` disables every registry source. */
  registry?: false;
  queryRegistry?: RegistryQuery;
  steamRoots?: string[];
  epicManifestRoots?: string[];
  gogGames?: GogInstall[];
  /** Drive roots probed for `.GamingRoot` / `XboxGames`. Default: every reachable drive letter. */
  driveRoots?: string[];
  riotMetadataRoots?: string[];
  itchRoots?: string[];
  /** Installed Microsoft Store packages that ship a MicrosoftGame.config. */
  storePackages?: () => Promise<launcher.StorePackage[]>;
};
export type DetectionResult = Detection;
export type ScanProgress = {
  launcher: string;
  done: number;
  total: number;
  found: number;
};
const localPath = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => path.isAbsolute(value) && !value.startsWith("\\\\"));
const gameName = z.string().trim().min(1).max(80);
// @node-steam/vdf turns numeric-looking strings into numbers ("StateFlags" "4" -> 4, name "1943" -> 1943).
const vdfString = z.union([z.string(), z.number()]).transform(String);
const installDir = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/:]/.test(value) && value !== "." && value !== "..");
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function within(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
async function directory(input: string): Promise<string> {
  localPath.parse(input);
  const resolved = await realpath(input);
  localPath.parse(resolved);
  if (!(await stat(resolved)).isDirectory())
    throw new Error("Install directory missing");
  return resolved;
}
async function installExecutable(
  install: string,
  input?: string,
): Promise<string | null> {
  if (!input) return null;
  const candidate = path.isAbsolute(input) ? input : path.join(install, input);
  if (!within(install, candidate))
    throw new Error("Executable escapes install directory");
  const resolved = await safeExecutable(candidate);
  if (!within(install, resolved))
    throw new Error("Executable escapes install directory");
  return resolved;
}

// A missing, non-.exe or escaping executable must not hide a game: the install folder is enough to match it.
const softExecutable = (install: string, input?: string) =>
  installExecutable(install, input).catch(() => null);

// Sources run in priority order (launcher-specific, then the registry heuristic), so the first writer wins.
function collector() {
  const games: Game[] = [];
  const byKey = new Map<string, Game>();
  let dropped = 0;
  // `install` must already be a realpath. Returns true when the game was added.
  function add(
    name: string,
    install: string,
    source: Game["source"],
    executablePath: string | null,
  ): boolean {
    const key = install.toLowerCase();
    if (byKey.has(key)) return false;
    if (games.length >= 500) {
      dropped++;
      return false;
    }
    // Generic sources must not list a helper folder inside, or a parent folder of, a known game.
    if (source === "registry" || source === "folder" || source === "msstore")
      for (const known of byKey.keys())
        if (
          known.startsWith(key + path.sep) ||
          key.startsWith(known + path.sep)
        )
          return false;
    const game: Game = {
      id: randomUUID(),
      name,
      path: install,
      source,
      executablePath,
      profile: "balanced",
      notes: "",
    };
    byKey.set(key, game);
    games.push(game);
    return true;
  }
  // Validates one found record (name, install directory, optional executable) and adds it.
  async function addFound(
    source: Game["source"],
    found: Found,
    skip: () => void,
  ) {
    try {
      const name = gameName.parse(found.name.trim().slice(0, 80));
      const install = await directory(found.installPath);
      add(
        name,
        install,
        source,
        await softExecutable(install, found.executable),
      );
    } catch (error) {
      if (!missing(error)) skip();
    }
  }
  return { games, add, addFound, dropped: () => dropped };
}

async function fixedDrives(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  // A dead network drive must not stall the scan: probe in parallel with a short timeout.
  const probes = [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map(async (letter) => {
    const root = `${letter}:\\`;
    const alive = await Promise.race([
      stat(root).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 1500).unref(),
      ),
    ]);
    return alive ? root : null;
  });
  return (await Promise.all(probes)).filter(
    (root): root is string => root !== null,
  );
}

async function subdirectories(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

const sourceCap = 500;
// Real Windows: Store packages that ship a MicrosoftGame.config. PowerShell runs a fixed script with
// no user input; the package database is read-only and WindowsApps itself is never listed.
async function installedStorePackages(): Promise<launcher.StorePackage[]> {
  if (process.platform !== "win32") return [];
  const script = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "$ErrorActionPreference='Stop'",
    "$names=@{}",
    "try{Get-StartApps|ForEach-Object{$k=$_.AppID.Split('!')[0];if(-not $names.ContainsKey($k)){$names[$k]=$_.Name}}}catch{}",
    "$found=@(Get-AppxPackage|Where-Object{$_.InstallLocation -and -not $_.IsFramework -and $_.SignatureKind -ne 'System'}|Where-Object{Test-Path -LiteralPath (Join-Path $_.InstallLocation 'MicrosoftGame.config')}|ForEach-Object{[pscustomobject]@{name=$names[$_.PackageFamilyName];installLocation=$_.InstallLocation}})",
    "ConvertTo-Json -Compress -InputObject $found",
  ].join(";");
  const { stdout } = await promisify(execFile)(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, shell: false, timeout: 30000, encoding: "utf8" },
  );
  return launcher.parseStorePackages(stdout);
}

type Status = "scanned" | "not-installed";
type Source = {
  source: Game["source"];
  run: (skip: () => void, cap: <T>(items: T[]) => T[]) => Promise<Status>;
};

export async function detectInstalledGames(
  options: DetectionOptions = {},
  onProgress?: (progress: ScanProgress) => void,
): Promise<DetectionResult> {
  const result: DetectionResult = {
    games: [],
    warnings: [],
    launchers: [],
    perLauncher: [],
  };
  const { games, add, addFound, dropped } = collector();
  const cache = new Map<string, Promise<RegistryRecord[]>>();
  const reg: RegistryQuery = (key) => {
    if (options.registry === false) return Promise.resolve([]);
    let query = cache.get(key);
    if (!query) {
      query = (options.queryRegistry ?? queryRegistry)(key);
      cache.set(key, query);
    }
    return query;
  };
  const regAll = async (keys: string[]) =>
    (await Promise.all(keys.map(reg))).flat();
  const uninstallKeys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const uninstalls = () => regAll(uninstallKeys);
  const programData = process.env.ProgramData;

  const sources: Source[] = [
    {
      source: "steam",
      run: async (skip, cap) => {
        const defaultSteam = [
          process.env["ProgramFiles(x86)"],
          process.env.ProgramFiles,
        ]
          .filter((value): value is string => Boolean(value))
          .map((base) => path.join(base, "Steam"));
        const fromRegistry: string[] = [];
        try {
          for (const record of await regAll([
            "HKCU\\Software\\Valve\\Steam",
            "HKLM\\Software\\Valve\\Steam",
            "HKLM\\Software\\WOW6432Node\\Valve\\Steam",
          ])) {
            const root = record.values.steampath ?? record.values.installpath;
            if (root && localPath.safeParse(root).success)
              fromRegistry.push(root);
          }
        } catch {
          result.warnings.push(
            "Could not read Steam installation registry metadata.",
          );
        }
        const roots = new Map<string, string>();
        async function addRoot(candidate: string) {
          if (roots.size >= 32) return;
          const root = await directory(candidate);
          roots.set(root.toLowerCase(), root);
        }
        for (const candidate of [
          ...(options.steamRoots ?? defaultSteam),
          ...fromRegistry,
        ].slice(0, 32)) {
          try {
            await addRoot(candidate);
          } catch (error) {
            if (!missing(error))
              result.warnings.push(
                "A Steam installation directory could not be read.",
              );
          }
        }
        for (const root of [...roots.values()]) {
          try {
            const data = z
              .object({ libraryfolders: z.record(z.string(), z.unknown()) })
              .parse(
                await readVdf(
                  path.join(root, "steamapps", "libraryfolders.vdf"),
                ),
              );
            for (const [index, folder] of Object.entries(data.libraryfolders)) {
              if (!/^\d+$/.test(index)) continue;
              const candidate =
                typeof folder === "string"
                  ? folder
                  : z.object({ path: vdfString.pipe(localPath) }).parse(folder)
                      .path;
              try {
                await addRoot(candidate);
              } catch (error) {
                if (!missing(error))
                  result.warnings.push(
                    "A Steam library directory could not be read.",
                  );
              }
            }
          } catch (error) {
            if (!missing(error))
              result.warnings.push("Steam library metadata could not be read.");
          }
        }
        let scanned = false;
        for (const root of roots.values()) {
          const steamapps = path.join(root, "steamapps");
          try {
            const files = (await readdir(steamapps)).filter((file) =>
              /^appmanifest_\d+\.acf$/i.test(file),
            );
            scanned = true;
            for (const file of cap(files)) {
              try {
                const data = z
                  .object({
                    AppState: z.object({
                      name: vdfString.pipe(gameName),
                      installdir: vdfString.pipe(installDir),
                      StateFlags: vdfString
                        .pipe(z.string().regex(/^\d+$/))
                        .optional(),
                    }),
                  })
                  .parse(await readVdf(path.join(steamapps, file)));
                const appId = /\d+/.exec(file)![0];
                if (launcher.isSteamNonGame(appId, data.AppState.name))
                  continue;
                if (
                  data.AppState.StateFlags &&
                  (Number(data.AppState.StateFlags) & 4) !== 4
                )
                  continue;
                const common = await directory(path.join(steamapps, "common"));
                const install = await directory(
                  path.join(common, data.AppState.installdir),
                );
                if (!within(common, install))
                  throw new Error("Install escapes Steam library");
                add(data.AppState.name, install, "steam", null);
              } catch (error) {
                if (!missing(error)) skip();
              }
            }
          } catch (error) {
            if (!missing(error))
              result.warnings.push("A Steam library could not be scanned.");
          }
        }
        return scanned ? "scanned" : "not-installed";
      },
    },
    {
      source: "epic",
      run: async (skip, cap) => {
        const epicRoots =
          options.epicManifestRoots ??
          (programData
            ? [
                path.join(
                  programData,
                  "Epic",
                  "EpicGamesLauncher",
                  "Data",
                  "Manifests",
                ),
              ]
            : []);
        let scanned = false;
        for (const root of epicRoots.slice(0, 8)) {
          try {
            const metadataRoot = await directory(root);
            const files = (await readdir(metadataRoot)).filter((file) =>
              file.toLowerCase().endsWith(".item"),
            );
            scanned = true;
            for (const file of cap(files)) {
              try {
                const data = z
                  .object({
                    DisplayName: gameName,
                    InstallLocation: localPath,
                    LaunchExecutable: z.string().max(2048).optional(),
                    AppCategories: z.array(z.string()).optional(),
                    bIsIncompleteInstall: z.boolean().optional(),
                    bIsApplication: z.boolean().optional(),
                  })
                  .parse(
                    JSON.parse(
                      await readText(path.join(metadataRoot, file)),
                    ) as unknown,
                  );
                if (
                  data.bIsIncompleteInstall ||
                  data.bIsApplication === false ||
                  launcher.isEpicNonGame(data.AppCategories)
                )
                  continue;
                const install = await directory(data.InstallLocation);
                add(
                  data.DisplayName,
                  install,
                  "epic",
                  await softExecutable(install, data.LaunchExecutable),
                );
              } catch (error) {
                if (!missing(error)) skip();
              }
            }
          } catch (error) {
            if (!missing(error))
              result.warnings.push(
                "Epic Games installation metadata could not be scanned.",
              );
          }
        }
        return scanned ? "scanned" : "not-installed";
      },
    },
    {
      source: "gog",
      run: async (skip, cap) => {
        const records = await regAll([
          "HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games",
          "HKLM\\SOFTWARE\\GOG.com\\Games",
        ]);
        const found: Found[] = [
          ...(options.gogGames ?? []).map((game) => ({
            name: game.name,
            installPath: game.path,
            ...(game.executablePath ? { executable: game.executablePath } : {}),
          })),
          ...launcher.parseGog(records),
        ];
        for (const game of cap(found)) await addFound("gog", game, skip);
        return found.length || records.length ? "scanned" : "not-installed";
      },
    },
    {
      source: "xbox",
      run: async (skip, cap) => {
        const drives = options.driveRoots ?? (await fixedDrives());
        const candidates = new Map<string, string>();
        for (const drive of drives) {
          let names: string[] = [];
          try {
            const file = path.join(drive, ".GamingRoot");
            if ((await stat(file)).size <= 64 * 1024) {
              names = launcher.parseGamingRoot(await readFile(file));
            }
          } catch (error) {
            if (!missing(error)) skip();
          }
          for (const name of names.length ? names : ["XboxGames"]) {
            const root = path.join(drive, name);
            candidates.set(root.toLowerCase(), root);
          }
        }
        let scanned = false;
        for (const candidate of candidates.values()) {
          try {
            const root = await directory(candidate);
            scanned = true;
            for (const folder of cap(await subdirectories(root))) {
              try {
                const install = await directory(path.join(root, folder));
                const config = launcher.parseMicrosoftGameConfig(
                  await readText(
                    path.join(install, "Content", "MicrosoftGame.config"),
                  ),
                  folder,
                );
                // A wrong Executable entry must not hide the game, so it only drops the executable.
                const executable = config.executable
                  ? await softExecutable(
                      install,
                      path.join("Content", config.executable),
                    )
                  : null;
                await addFound(
                  "xbox",
                  {
                    name: config.name,
                    installPath: install,
                    ...(executable ? { executable } : {}),
                  },
                  skip,
                );
              } catch (error) {
                if (!missing(error)) skip();
              }
            }
          } catch (error) {
            if (!missing(error)) skip();
          }
        }
        return scanned ? "scanned" : "not-installed";
      },
    },
    {
      source: "msstore",
      run: async (skip, cap) => {
        const packages = cap(
          await (
            options.storePackages ??
            (options.registry === false
              ? async () => []
              : installedStorePackages)
          )(),
        );
        for (const pkg of packages) {
          try {
            const install = await directory(pkg.installLocation);
            const config = launcher.parseMicrosoftGameConfig(
              await readText(path.join(install, "MicrosoftGame.config")),
              path.basename(pkg.installLocation),
            );
            await addFound(
              "msstore",
              {
                name: pkg.name ?? config.name,
                installPath: install,
                ...(config.executable ? { executable: config.executable } : {}),
              },
              skip,
            );
          } catch (error) {
            if (!missing(error)) skip();
          }
        }
        return packages.length ? "scanned" : "not-installed";
      },
    },
    {
      source: "ea",
      run: async (skip, cap) => {
        const records = await regAll([
          "HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts",
          "HKLM\\SOFTWARE\\WOW6432Node\\EA Games",
          "HKLM\\SOFTWARE\\Electronic Arts",
          "HKLM\\SOFTWARE\\EA Games",
        ]);
        for (const game of cap(launcher.parseEa(records)))
          await addFound("ea", game, skip);
        return records.length ? "scanned" : "not-installed";
      },
    },
    {
      source: "ubisoft",
      run: async (skip, cap) => {
        const installs = await reg(
          "HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs",
        );
        const found = launcher.parseUbisoft(installs, await uninstalls());
        for (const game of cap(found)) await addFound("ubisoft", game, skip);
        return installs.length ? "scanned" : "not-installed";
      },
    },
    {
      source: "battlenet",
      run: async (skip, cap) => {
        const all = await uninstalls();
        for (const game of cap(launcher.parseBattlenet(all)))
          await addFound("battlenet", game, skip);
        return all.some(
          (record) => record.values.publisher === "Blizzard Entertainment",
        )
          ? "scanned"
          : "not-installed";
      },
    },
    {
      source: "riot",
      run: async (skip, cap) => {
        const roots =
          options.riotMetadataRoots ??
          (programData
            ? [path.join(programData, "Riot Games", "Metadata")]
            : []);
        let scanned = false;
        for (const candidate of roots.slice(0, 4)) {
          try {
            const root = await directory(candidate);
            scanned = true;
            for (const folder of cap(await subdirectories(root))) {
              try {
                const found = launcher.parseRiotSettings(
                  await readText(
                    path.join(root, folder, `${folder}.product_settings.yaml`),
                  ),
                  folder,
                );
                // Riot Client, patch-only and uninstalled products have no install line.
                if (found) await addFound("riot", found, skip);
              } catch (error) {
                if (!missing(error)) skip();
              }
            }
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
        return scanned ? "scanned" : "not-installed";
      },
    },
    {
      source: "rockstar",
      run: async (skip, cap) => {
        const records = await regAll([
          "HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games",
          "HKLM\\SOFTWARE\\Rockstar Games",
        ]);
        const found = launcher.parseRockstar(records, await uninstalls());
        for (const game of cap(found)) await addFound("rockstar", game, skip);
        return records.length || found.length ? "scanned" : "not-installed";
      },
    },
    {
      source: "itch",
      run: async (skip, cap) => {
        const roots =
          options.itchRoots ??
          (process.env.APPDATA
            ? [path.join(process.env.APPDATA, "itch", "apps")]
            : []);
        let scanned = false;
        for (const candidate of roots.slice(0, 4)) {
          try {
            const root = await directory(candidate);
            scanned = true;
            for (const folder of cap(await subdirectories(root))) {
              try {
                const install = path.join(root, folder);
                const title = launcher.parseItchReceipt(
                  await readFile(
                    path.join(install, ".itch", "receipt.json.gz"),
                  ),
                );
                if (title)
                  await addFound(
                    "itch",
                    { name: title, installPath: install },
                    skip,
                  );
              } catch (error) {
                if (!missing(error)) skip();
              }
            }
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
        return scanned ? "scanned" : "not-installed";
      },
    },
    {
      source: "registry",
      run: async (skip, cap) => {
        const all = await uninstalls();
        for (const game of cap(launcher.parseUninstallHeuristic(all)))
          await addFound("registry", game, skip);
        return all.length ? "scanned" : "not-installed";
      },
    },
  ];

  for (const [index, { source, run }] of sources.entries()) {
    const label = sourceLabels[source];
    let skipped = 0;
    let status: DetectionResult["perLauncher"][number]["status"] = "error";
    const cap = <T>(items: T[]): T[] => {
      if (items.length <= sourceCap) return items;
      result.warnings.push(
        `${label}: only the first ${sourceCap} entries were scanned.`,
      );
      return items.slice(0, sourceCap);
    };
    try {
      status = await run(() => skipped++, cap);
    } catch {
      result.warnings.push(`${label} could not be scanned.`);
    }
    if (skipped)
      result.warnings.push(
        `${label}: skipped ${skipped} invalid installation metadata record(s).`,
      );
    if (status === "scanned") result.launchers.push(label);
    result.perLauncher.push({
      launcher: label,
      found: games.filter((game) => game.source === source).length,
      skipped,
      status,
    });
    onProgress?.({
      launcher: label,
      done: index + 1,
      total: sources.length,
      found: games.length,
    });
  }
  if (dropped())
    result.warnings.push(
      `The library holds at most 500 games; ${dropped()} more were not added.`,
    );
  result.games = games;
  return result;
}

// Folder scan chosen by the user: each immediate subfolder is a candidate game.
async function findExecutables(
  root: string,
  depth: number,
): Promise<{ file: string; size: number }[]> {
  const found: { file: string; size: number }[] = [];
  let seen = 0;
  async function walk(folder: string, level: number) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++seen > 3000) return;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory() && level < depth) await walk(full, level + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
        found.push({ file: full, size: (await stat(full)).size });
    }
  }
  await walk(root, 0);
  return found;
}

export async function scanGameFolder(folder: string): Promise<DetectionResult> {
  const root = await directory(folder);
  const result: DetectionResult = {
    games: [],
    warnings: [],
    launchers: [],
    perLauncher: [],
  };
  const { games, add } = collector();
  let skipped = 0;
  const folders = await subdirectories(root);
  if (folders.length > 200)
    result.warnings.push("Only the first 200 folders were scanned.");
  for (const name of folders.slice(0, 200)) {
    try {
      const install = await directory(path.join(root, name));
      const executable = launcher.pickGameExecutable(
        await findExecutables(install, 3),
      );
      if (executable)
        add(
          name.slice(0, 80),
          install,
          "folder",
          await installExecutable(install, executable),
        );
    } catch (error) {
      if (!missing(error)) skipped++;
    }
  }
  if (skipped)
    result.warnings.push(
      `${sourceLabels.folder}: skipped ${skipped} unreadable folder(s).`,
    );
  result.games = games;
  result.launchers.push(sourceLabels.folder);
  result.perLauncher.push({
    launcher: sourceLabels.folder,
    found: games.length,
    skipped,
    status: "scanned",
  });
  return result;
}
