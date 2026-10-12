import { readFile, readdir, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "@node-steam/vdf";
import { z } from "zod";
import type { Game } from "../shared/contracts.js";
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
async function readVdf(file: string): Promise<unknown> {
  if ((await stat(file)).size > 1024 * 1024)
    throw new Error("Metadata file too large");
  return parse(await readFile(file, "utf8")) as unknown;
}
type GogInstall = { name: string; path: string; executablePath?: string };
export type DetectionOptions = {
  registry?: false;
  steamRoots?: string[];
  epicManifestRoots?: string[];
  gogGames?: GogInstall[];
};
export type DetectionResult = {
  games: Game[];
  warnings: string[];
  launchers: string[];
};
const executeFile = promisify(execFile);
const localPath = z.string().min(1).max(2048).refine(
  (value) => path.isAbsolute(value) && !value.startsWith("\\\\"),
);
const gameName = z.string().trim().min(1).max(80);
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function within(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function directory(input: string): Promise<string> {
  localPath.parse(input);
  const resolved = await realpath(input);
  localPath.parse(resolved);
  if (!(await stat(resolved)).isDirectory()) throw new Error("Install directory missing");
  return resolved;
}
async function installExecutable(install: string, input?: string): Promise<string | null> {
  if (!input) return null;
  const candidate = path.isAbsolute(input) ? input : path.join(install, input);
  if (!within(install, candidate)) throw new Error("Executable escapes install directory");
  const resolved = await safeExecutable(candidate);
  if (!within(install, resolved)) throw new Error("Executable escapes install directory");
  return resolved;
}

// reg.exe receives fixed keys through argument arrays, never renderer text or a shell.
async function registryInstalls(warnings: string[]): Promise<{ steam: string[]; gog: GogInstall[] }> {
  const result: { steam: string[]; gog: GogInstall[] } = { steam: [], gog: [] };
  if (process.platform !== "win32") return result;
  const queries = [
    { key: "HKCU\\Software\\Valve\\Steam", source: "steam" },
    { key: "HKLM\\Software\\Valve\\Steam", source: "steam" },
    { key: "HKLM\\Software\\WOW6432Node\\Valve\\Steam", source: "steam" },
    { key: "HKLM\\Software\\GOG.com\\Games", source: "gog" },
    { key: "HKLM\\Software\\WOW6432Node\\GOG.com\\Games", source: "gog" },
  ] as const;
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  for (const query of queries) {
    try {
      const { stdout } = await executeFile(executable, ["query", query.key, "/s"], {
        windowsHide: true, shell: false, timeout: 10000, maxBuffer: 1024 * 1024,
      });
      const records: Record<string, string>[] = [];
      let record: Record<string, string> | undefined;
      for (const line of stdout.split(/\r?\n/)) {
        if (/^HKEY_/.test(line.trim())) {
          record = {};
          records.push(record);
        } else {
          const value = /^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line);
          if (record && value) record[value[1]!.toLowerCase()] = value[2]!.trim();
        }
      }
      for (const record of records) {
        if (query.source === "steam") {
          const root = record.steampath ?? record.installpath;
          if (root && localPath.safeParse(root).success) result.steam.push(root);
        } else if (record.gamename && record.path) {
          result.gog.push({ name: record.gamename, path: record.path, ...(record.exe ? { executablePath: record.exe.replace(/^"(.*)"$/, "$1") } : {}) });
        }
      }
    } catch (error) {
      // A missing optional launcher registry key is reg.exe exit code 1.
      if ((error as { code?: number }).code !== 1)
        warnings.push(`Could not read ${query.source === "steam" ? "Steam" : "GOG"} installation registry metadata.`);
    }
  }
  return result;
}

export async function detectInstalledGames(options: DetectionOptions = {}): Promise<DetectionResult> {
  const result: DetectionResult = { games: [], warnings: [], launchers: [] };
  const registry = options.registry === false ? { steam: [], gog: [] } : await registryInstalls(result.warnings);
  const defaultSteam = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter((value): value is string => Boolean(value)).map((base) => path.join(base, "Steam"));
  const rootCandidates = [...(options.steamRoots ?? defaultSteam), ...registry.steam];
  const roots = new Map<string, string>();
  const paths = new Set<string>();
  let skippedSteam = 0;
  let skippedEpic = 0;
  let skippedGog = 0;
  function add(name: string, install: string, source: Game["source"], executablePath: string | null) {
    const key = install.toLowerCase();
    if (paths.has(key) || result.games.length >= 500) return;
    paths.add(key);
    result.games.push({ id: randomUUID(), name, path: install, source, executablePath, profile: "balanced", notes: "" });
  }
  async function addRoot(candidate: string) {
    if (roots.size >= 32) return;
    const root = await directory(candidate);
    roots.set(root.toLowerCase(), root);
  }
  for (const candidate of rootCandidates.slice(0, 32)) {
    try { await addRoot(candidate); }
    catch (error) { if (!missing(error)) result.warnings.push("A Steam installation directory could not be read."); }
  }
  for (const root of [...roots.values()]) {
    try {
      const data = z.object({ libraryfolders: z.record(z.string(), z.unknown()) })
        .parse(await readVdf(path.join(root, "steamapps", "libraryfolders.vdf")));
      for (const [index, folder] of Object.entries(data.libraryfolders)) {
        if (!/^\d+$/.test(index)) continue;
        const candidate = typeof folder === "string" ? folder : z.object({ path: localPath }).parse(folder).path;
        try { await addRoot(candidate); }
        catch (error) { if (!missing(error)) result.warnings.push("A Steam library directory could not be read."); }
      }
    } catch (error) { if (!missing(error)) result.warnings.push("Steam library metadata could not be read."); }
  }
  for (const root of roots.values()) {
    const steamapps = path.join(root, "steamapps");
    try {
      const files = (await readdir(steamapps)).filter((file) => /^appmanifest_\d+\.acf$/i.test(file)).slice(0, 500);
      if (!result.launchers.includes("Steam")) result.launchers.push("Steam");
      for (const file of files) {
        if (file.toLowerCase() === "appmanifest_228980.acf") continue;
        try {
          const data = z.object({ AppState: z.object({
            name: gameName,
            installdir: z.string().min(1).max(255).refine((value) => !/[\\/:]/.test(value) && value !== "." && value !== ".."),
            StateFlags: z.string().regex(/^\d+$/).optional(),
          }) }).parse(await readVdf(path.join(steamapps, file)));
          if (data.AppState.StateFlags && (Number(data.AppState.StateFlags) & 4) !== 4) continue;
          const common = await directory(path.join(steamapps, "common"));
          const install = await directory(path.join(common, data.AppState.installdir));
          if (!within(common, install)) throw new Error("Install escapes Steam library");
          add(data.AppState.name, install, "steam", null);
        } catch (error) { if (!missing(error)) skippedSteam++; }
      }
    } catch (error) { if (!missing(error)) result.warnings.push("A Steam library could not be scanned."); }
  }
  const epicRoots = options.epicManifestRoots ?? (process.env.ProgramData ? [path.join(process.env.ProgramData, "Epic", "EpicGamesLauncher", "Data", "Manifests")] : []);
  for (const root of epicRoots.slice(0, 8)) {
    try {
      const metadataRoot = await directory(root);
      const files = (await readdir(metadataRoot)).filter((file) => file.toLowerCase().endsWith(".item")).slice(0, 500);
      if (!result.launchers.includes("Epic Games")) result.launchers.push("Epic Games");
      for (const file of files) {
        try {
          const manifest = path.join(metadataRoot, file);
          if ((await stat(manifest)).size > 1024 * 1024) throw new Error("Metadata file too large");
          const data = z.object({
            DisplayName: gameName, InstallLocation: localPath,
            LaunchExecutable: z.string().max(2048).optional(),
            bIsIncompleteInstall: z.boolean().optional(), bIsApplication: z.boolean().optional(),
          }).parse(JSON.parse(await readFile(manifest, "utf8")) as unknown);
          if (data.bIsIncompleteInstall || data.bIsApplication === false) continue;
          const install = await directory(data.InstallLocation);
          add(data.DisplayName, install, "epic", await installExecutable(install, data.LaunchExecutable));
        } catch (error) { if (!missing(error)) skippedEpic++; }
      }
    } catch (error) { if (!missing(error)) result.warnings.push("Epic Games installation metadata could not be scanned."); }
  }
  const gogGames = [...(options.gogGames ?? []), ...registry.gog];
  if (gogGames.length) result.launchers.push("GOG");
  for (const game of gogGames.slice(0, 500)) {
    try {
      const name = gameName.parse(game.name);
      const install = await directory(game.path);
      add(name, install, "gog", await installExecutable(install, game.executablePath));
    } catch (error) { if (!missing(error)) skippedGog++; }
  }
  for (const [launcher, count] of [["Steam", skippedSteam], ["Epic Games", skippedEpic], ["GOG", skippedGog]] as const)
    if (count) result.warnings.push(`${launcher}: skipped ${count} invalid installation metadata record(s).`);
  return result;
}

export async function detectSteamGames(): Promise<Game[]> {
  return (await detectInstalledGames({ epicManifestRoots: [], gogGames: [] })).games.filter((game) => game.source === "steam");
}
