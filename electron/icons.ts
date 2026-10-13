import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Game } from "../shared/contracts.js";
import { pickGameExecutable } from "./launchers.js";
import { queryRegistry } from "./registry.js";
import { safeExecutable, within } from "./games.js";

export interface IconDeps {
  /** Cache folder, normally userData/icons. */
  dir: string;
  /** Steam install roots to look for appcache\librarycache in; defaults to the registry and Program Files. */
  steamRoots?: () => Promise<string[]>;
  /** PNG bytes of an executable's shell icon (Electron app.getFileIcon). */
  fileIcon: (exe: string) => Promise<Buffer | null>;
  /** PNG bytes of an image file, already scaled down (Electron nativeImage). */
  image: (file: string) => Promise<Buffer | null>;
  /** The shell's stand-in icon for an executable with none; matching it means "no icon", so the letter shows. */
  genericIcon?: () => Promise<Buffer | null>;
}

const prefix = "data:image/png;base64,";
/** Larger icons are not served (the IPC schema allows 300 KB of base64). */
export const maxIconBytes = 200_000;
const retryMarker = "retry";
const retryAfterMs = 24 * 3600_000;
const hex40 = /^[0-9a-f]{40}\.(jpe?g|png)$/i;

async function realDir(input: string): Promise<string | null> {
  try {
    if (!path.isAbsolute(input) || input.startsWith("\\\\")) return null;
    const real = await realpath(input);
    return !real.startsWith("\\\\") && (await stat(real)).isDirectory()
      ? real
      : null;
  } catch {
    return null;
  }
}

/** A regular file that still lies inside `root` once links are resolved. */
async function realFileWithin(root: string, file: string) {
  try {
    const real = await realpath(file);
    return within(root, real) && (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

export async function defaultSteamRoots(): Promise<string[]> {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter((v): v is string => Boolean(v))
    .map((base) => path.join(base, "Steam"));
  for (const key of [
    "HKCU\\Software\\Valve\\Steam",
    "HKLM\\Software\\Valve\\Steam",
    "HKLM\\Software\\WOW6432Node\\Valve\\Steam",
  ])
    try {
      for (const { values } of await queryRegistry(key))
        roots.push(values.steampath ?? values.installpath ?? "");
    } catch {
      /* Steam not installed */
    }
  return roots.filter(Boolean);
}

export class GameIcons {
  private manifests = new Map<
    string,
    { at: number; ids: Promise<Map<string, string>> }
  >();
  constructor(private deps: IconDeps) {}

  /** PNG data URL for a library game, or null. Never throws; every path comes from the saved game, not the caller. */
  async dataUrl(game: Game): Promise<string | null> {
    try {
      const source = await this.source(game);
      return source ? await this.cached(source) : null;
    } catch {
      return null;
    }
  }

  // Keyed by source path, mtime and size, so changed art or a patched exe regenerates on the next request.
  private async key(source: { file: string; art: boolean }) {
    const info = await stat(source.file);
    return createHash("sha256")
      .update(
        `v1|${source.art}|${source.file.toLowerCase()}|${info.mtimeMs}|${info.size}`,
      )
      .digest("hex")
      .slice(0, 32);
  }

  // An empty <key>.png records "this source has no usable icon" (generic or oversized): never retried.
  // A "retry" marker (extraction returned nothing, possibly transient) is retried after a day.
  private async cached(source: { file: string; art: boolean }) {
    const target = path.join(this.deps.dir, `${await this.key(source)}.png`);
    let png: Buffer | null = await readFile(target).catch(() => null);
    if (png?.length === retryMarker.length && png.toString() === retryMarker) {
      const age = Date.now() - (await stat(target)).mtimeMs;
      if (age < retryAfterMs) return null;
      png = null;
    }
    if (!png) {
      const made = await (source.art
        ? this.deps.image(source.file)
        : this.deps.fileIcon(source.file));
      const generic =
        made && !source.art ? await this.deps.genericIcon?.() : null;
      png = !made
        ? Buffer.from(retryMarker)
        : made.length <= maxIconBytes && !(generic && made.equals(generic))
          ? made
          : Buffer.alloc(0);
      await mkdir(this.deps.dir, { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, png);
      await rename(temp, target);
    }
    // A real PNG is longer than the 5-byte marker; empty means "no icon".
    return png.length > retryMarker.length && png.length <= maxIconBytes
      ? prefix + png.toString("base64")
      : null;
  }

  /** Deletes cached PNGs that no library game's current icon source maps to. */
  async prune(games: Game[]): Promise<void> {
    const keep = new Set<string>();
    for (const game of games)
      try {
        const source = await this.source(game);
        if (source) keep.add(`${await this.key(source)}.png`);
      } catch {
        /* no source, nothing to keep */
      }
    for (const file of await readdir(this.deps.dir).catch(() => [] as string[]))
      if (/^[0-9a-f]{32}\.png$/.test(file) && !keep.has(file))
        await rm(path.join(this.deps.dir, file), { force: true });
  }

  /** Launcher art first (Steam), then the game's own executable. */
  private async source(game: Game) {
    const install = await realDir(game.path);
    if (!install) return null;
    if (game.source === "steam") {
      const art = await this.steamArt(install);
      if (art) return { file: art, art: true };
    }
    const exe = await this.executable(game, install);
    return exe ? { file: exe, art: false } : null;
  }

  private async executable(game: Game, install: string) {
    const check = async (candidate: string) => {
      try {
        const real = await safeExecutable(candidate);
        return within(install, real) ? real : null;
      } catch {
        return null;
      }
    };
    if (game.executablePath) {
      const known = await check(game.executablePath);
      if (known) return known;
    }
    // Top level first, then up to two folders down (Unreal games keep Binaries\Win64 there).
    const files: { file: string; size: number }[] = [];
    let level = [install];
    for (let depth = 0; depth < 3 && level.length; depth++) {
      const next: string[] = [];
      for (const dir of level.slice(0, 40)) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(
          () => [],
        );
        for (const entry of entries) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) next.push(file);
          else if (entry.isFile() && /\.exe$/i.test(entry.name))
            files.push({
              file,
              size: (await stat(file).catch(() => null))?.size ?? 0,
            });
        }
      }
      if (pickGameExecutable(files)) break;
      level = next;
    }
    const picked = pickGameExecutable(files);
    return picked ? check(picked) : null;
  }

  // <steam>\appcache\librarycache lives under the Steam install, not under the game's library folder.
  private async steamArt(install: string): Promise<string | null> {
    const common = path.dirname(install);
    if (path.basename(common).toLowerCase() !== "common") return null;
    const steamapps = path.dirname(common);
    const appId = (await this.appIds(steamapps)).get(
      path.basename(install).toLowerCase(),
    );
    if (!appId) return null;
    const roots = [
      path.dirname(steamapps),
      ...(await (this.deps.steamRoots ?? defaultSteamRoots)()),
    ];
    for (const root of roots) {
      const cache = await realDir(path.join(root, "appcache", "librarycache"));
      const art = cache ? await this.pickArt(cache, appId) : null;
      if (art) return art;
    }
    return null;
  }

  private async pickArt(cache: string, appId: string) {
    const folder = path.join(cache, appId);
    const names = await readdir(folder, { withFileTypes: true }).catch(
      () => [],
    );
    const candidates = [
      path.join(cache, `${appId}_icon.jpg`),
      ...names
        .filter((e) => e.isFile() && hex40.test(e.name))
        .map((e) => path.join(folder, e.name)),
      path.join(folder, "library_600x900.jpg"),
      path.join(cache, `${appId}_library_600x900.jpg`),
    ];
    for (const entry of names.filter((e) => e.isDirectory()).slice(0, 10))
      candidates.push(
        path.join(folder, entry.name, "library_600x900.jpg"),
        path.join(folder, entry.name, "library_capsule.jpg"),
      );
    for (const file of candidates) {
      const real = await realFileWithin(cache, file);
      if (real) return real;
    }
    return null;
  }

  // installdir -> appid for one library from the small appmanifest files; kept briefly for bulk loads.
  private appIds(steamapps: string) {
    const hit = this.manifests.get(steamapps);
    if (hit && Date.now() - hit.at < 30_000) return hit.ids;
    const ids = (async () => {
      const map = new Map<string, string>();
      for (const file of await readdir(steamapps).catch(() => [] as string[])) {
        const id = /^appmanifest_(\d+)\.acf$/i.exec(file)?.[1];
        if (!id) continue;
        try {
          const text = await readFile(path.join(steamapps, file), "utf8");
          const dir = /"installdir"\s+"([^"]+)"/i.exec(text)?.[1];
          if (dir) map.set(dir.toLowerCase(), id);
        } catch {
          /* unreadable manifest */
        }
      }
      return map;
    })();
    this.manifests.set(steamapps, { at: Date.now(), ids });
    return ids;
  }
}
