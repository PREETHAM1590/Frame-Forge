import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GameIcons } from "../electron/icons";
import { GameIconSchema, type Game } from "../shared/contracts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "frameforge-icons-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const put = async (file: string, body: string | Buffer = "x") => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return file;
};
const game = (over: Partial<Game>): Game => ({
  id: crypto.randomUUID(),
  name: "Game",
  path: root,
  source: "folder",
  executablePath: null,
  profile: "balanced",
  boostMode: "global",
  notes: "",
  ...over,
});
function icons(steam?: string[]) {
  const fileIcon = vi.fn(async (exe: string) => Buffer.from(`exe:${exe}`));
  const image = vi.fn(async (file: string) => Buffer.from(`img:${file}`));
  const service = new GameIcons({
    dir: path.join(root, "cache"),
    steamRoots: async () => steam ?? [],
    fileIcon,
    image,
  });
  return { service, fileIcon, image };
}
const decode = (url: string | null) =>
  Buffer.from(url!.split(",")[1]!, "base64").toString();

describe("exe icons", () => {
  it("uses the known executable inside the install folder", async () => {
    const install = path.join(root, "Game");
    const exe = await put(path.join(install, "Game.exe"));
    const { service, fileIcon } = icons();
    const url = await service.dataUrl(
      game({ path: install, executablePath: exe }),
    );
    expect(GameIconSchema.safeParse(url).success).toBe(true);
    expect(decode(url)).toBe(`exe:${exe}`);
    expect(fileIcon).toHaveBeenCalledTimes(1);
  });

  it("picks the main executable when none is recorded, skipping installers and looking one folder down", async () => {
    const install = path.join(root, "Valorant");
    await put(path.join(install, "unins000.exe"), "x".repeat(100));
    await put(path.join(install, "Binaries", "Win64", "Real.exe"), "x");
    const { service } = icons();
    expect(decode(await service.dataUrl(game({ path: install })))).toContain(
      "Real.exe",
    );
    await put(path.join(install, "Game.exe"), "xx");
    expect(
      decode(await icons().service.dataUrl(game({ path: install }))),
    ).toContain(`${path.sep}Game.exe`);
  });

  it("ignores a recorded executable outside the install folder", async () => {
    const install = path.join(root, "Game");
    await mkdir(install, { recursive: true });
    const outside = await put(path.join(root, "Other", "Evil.exe"));
    const { service, fileIcon } = icons();
    expect(
      await service.dataUrl(game({ path: install, executablePath: outside })),
    ).toBeNull();
    expect(fileIcon).not.toHaveBeenCalled();
  });

  it("rejects relative, UNC, missing and non-directory install paths", async () => {
    const file = await put(path.join(root, "file.exe"));
    const { service, fileIcon } = icons();
    for (const bad of [
      "relative\\dir",
      "\\\\server\\share\\Game",
      path.join(root, "missing"),
      file,
    ])
      expect(await service.dataUrl(game({ path: bad }))).toBeNull();
    expect(fileIcon).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when icon extraction fails or is oversized", async () => {
    const install = path.join(root, "Game");
    await put(path.join(install, "Game.exe"));
    const failing = new GameIcons({
      dir: path.join(root, "cache"),
      fileIcon: async () => {
        throw new Error("boom");
      },
      image: async () => null,
    });
    expect(await failing.dataUrl(game({ path: install }))).toBeNull();
  });

  it("remembers that an oversized icon has no usable image instead of regenerating it", async () => {
    const install = path.join(root, "Game");
    await put(path.join(install, "Game.exe"));
    const fileIcon = vi.fn(async () => Buffer.alloc(300_000));
    const huge = new GameIcons({
      dir: path.join(root, "cache2"),
      fileIcon,
      image: async () => null,
    });
    const g = game({ path: install });
    expect(await huge.dataUrl(g)).toBeNull();
    expect(await huge.dataUrl(g)).toBeNull();
    expect(
      await new GameIcons({
        dir: path.join(root, "cache2"),
        fileIcon,
        image: async () => null,
      }).dataUrl(g),
    ).toBeNull();
    expect(fileIcon).toHaveBeenCalledTimes(1);
  });

  it("treats the shell's generic executable icon as no icon (letter fallback)", async () => {
    const install = path.join(root, "Roblox");
    await put(path.join(install, "RobloxPlayerBeta.exe"));
    const generic = Buffer.from("generic-exe-icon");
    const make = (icon: Buffer, dir: string) =>
      new GameIcons({
        dir: path.join(root, dir),
        fileIcon: async () => icon,
        image: async () => null,
        genericIcon: async () => generic,
      });
    const g = game({ path: install });
    expect(await make(generic, "c1").dataUrl(g)).toBeNull();
    expect(
      await make(Buffer.from("a real icon here"), "c2").dataUrl(g),
    ).not.toBeNull();
  });
});

describe("cache", () => {
  it("writes <hash>.png once, serves later calls from disk, and regenerates when the source changes", async () => {
    const install = path.join(root, "Game");
    const exe = await put(path.join(install, "Game.exe"), "v1");
    const { service, fileIcon } = icons();
    const g = game({ path: install, executablePath: exe });
    const first = await service.dataUrl(g);
    const second = await service.dataUrl(g);
    expect(second).toBe(first);
    expect(fileIcon).toHaveBeenCalledTimes(1);
    const files = await readdir(path.join(root, "cache"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.png$/);
    // A fresh instance (next app start) still hits the disk cache.
    const again = icons();
    expect(await again.service.dataUrl(g)).toBe(first);
    expect(again.fileIcon).not.toHaveBeenCalled();
    // The exe is patched: new mtime, new cache entry (a rescan picks it up).
    await utimes(exe, new Date(), new Date(Date.now() + 60_000));
    await service.dataUrl(g);
    expect(fileIcon).toHaveBeenCalledTimes(2);
    expect(await readdir(path.join(root, "cache"))).toHaveLength(2);
  });
});

describe("Steam launcher art", () => {
  async function steamLibrary(appId = "1304930") {
    const steam = path.join(root, "Steam");
    const install = path.join(
      steam,
      "steamapps",
      "common",
      "The Outlast Trials",
    );
    await mkdir(install, { recursive: true });
    await put(path.join(install, "Launcher.exe"));
    await put(
      path.join(steam, "steamapps", `appmanifest_${appId}.acf`),
      `"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"installdir"\t\t"The Outlast Trials"\n}`,
    );
    return {
      steam,
      install,
      cache: path.join(steam, "appcache", "librarycache"),
    };
  }
  const hash = "159a7d66ffd179c920eefe07392e6a261e899965.jpg";

  it("prefers the client icon in librarycache/<appid>/ over the executable", async () => {
    const { install, cache } = await steamLibrary();
    const art = await put(path.join(cache, "1304930", hash));
    await put(path.join(cache, "1304930", "logo.png"));
    const { service, image, fileIcon } = icons();
    const url = await service.dataUrl(game({ path: install, source: "steam" }));
    expect(decode(url)).toBe(`img:${art}`);
    expect(image).toHaveBeenCalledTimes(1);
    expect(fileIcon).not.toHaveBeenCalled();
  });

  it("prefers <appid>_icon.jpg, then falls back to capsule art in a hashed folder", async () => {
    const { install, cache } = await steamLibrary();
    const capsule = await put(
      path.join(
        cache,
        "1304930",
        "461ee91dac2ada55a6be417b24e7b04c07c86ddf",
        "library_capsule.jpg",
      ),
    );
    const { service } = icons();
    const g = game({ path: install, source: "steam" });
    expect(decode(await service.dataUrl(g))).toBe(`img:${capsule}`);
    const legacy = await put(path.join(cache, "1304930_icon.jpg"));
    expect(decode(await icons().service.dataUrl(g))).toBe(`img:${legacy}`);
  });

  it("finds the cache under another Steam install when the game lives in a second library", async () => {
    const { steam, cache } = await steamLibrary();
    await put(path.join(cache, "1304930", hash));
    const second = path.join(root, "SteamLibrary");
    const install = path.join(second, "steamapps", "common", "Other Game");
    await mkdir(install, { recursive: true });
    await put(
      path.join(second, "steamapps", "appmanifest_1304930.acf"),
      `"AppState" { "installdir" "Other Game" }`,
    );
    const { service, image } = icons([steam]);
    expect(
      await service.dataUrl(game({ path: install, source: "steam" })),
    ).not.toBeNull();
    expect(image).toHaveBeenCalledTimes(1);
  });

  it("falls back to the executable when there is no cached art", async () => {
    const { install } = await steamLibrary();
    const { service, fileIcon } = icons();
    const url = await service.dataUrl(game({ path: install, source: "steam" }));
    expect(decode(url)).toContain("Launcher.exe");
    expect(fileIcon).toHaveBeenCalledTimes(1);
  });

  it("rejects art that escapes librarycache through a link", async () => {
    const { install, cache } = await steamLibrary();
    const outside = path.join(root, "outside");
    await put(path.join(outside, hash));
    await mkdir(cache, { recursive: true });
    try {
      await symlink(outside, path.join(cache, "1304930"), "junction");
    } catch {
      return; // links not permitted on this machine
    }
    const { service, image } = icons();
    const url = await service.dataUrl(game({ path: install, source: "steam" }));
    expect(image).not.toHaveBeenCalled();
    expect(decode(url)).toContain("Launcher.exe");
  });
});

describe("prune", () => {
  it("deletes cached PNGs no library game uses and keeps the current ones", async () => {
    const install = path.join(root, "Game");
    const exe = await put(path.join(install, "Game.exe"), "v1");
    const gone = path.join(root, "Gone");
    await put(path.join(gone, "Gone.exe"));
    const { service } = icons();
    const keep = game({ path: install, executablePath: exe });
    const removed = game({ path: gone });
    await service.dataUrl(keep);
    await service.dataUrl(removed);
    // A patched exe leaves a stale entry behind.
    await utimes(exe, new Date(), new Date(Date.now() + 60_000));
    await service.dataUrl(keep);
    const cache = path.join(root, "cache");
    expect(await readdir(cache)).toHaveLength(3);
    await put(path.join(cache, "notes.txt"));
    await service.prune([keep]);
    const left = await readdir(cache);
    expect(left).toHaveLength(2); // the current icon and the unrelated file
    expect(left).toContain("notes.txt");
    expect(await service.dataUrl(keep)).not.toBeNull();
  });
});
