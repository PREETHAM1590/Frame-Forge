import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { detectInstalledGames } from "../electron/games.js";

const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "frameforge-games-"));
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
function vdf(root: string, fields: Record<string, string>) {
  const lines = Object.entries(fields).map(
    ([key, value]) => `\t"${key}"\t\t"${value}"`,
  );
  return `"${root}"\n{\n${lines.join("\n")}\n}\n`;
}
function manifest(appid: number, fields: Record<string, string>) {
  return vdf("AppState", { appid: String(appid), Universe: "1", ...fields });
}
const options = {
  registry: false as const,
  steamRoots: [],
  epicManifestRoots: [],
  gogGames: [],
  driveRoots: [],
  riotMetadataRoots: [],
  itchRoots: [],
};
describe("installed game discovery", () => {
  it("reads custom Steam libraries, deduplicates roots and skips stale or incomplete installs", async () => {
    const root = await fixture();
    const steam = path.join(root, "Custom Steam");
    const library = path.join(root, "Other Library");
    await mkdir(path.join(steam, "steamapps"), { recursive: true });
    await mkdir(path.join(library, "steamapps", "common", "Example"), {
      recursive: true,
    });
    await mkdir(path.join(library, "steamapps", "common", "Downloading"), {
      recursive: true,
    });
    await writeFile(
      path.join(steam, "steamapps", "libraryfolders.vdf"),
      `"libraryfolders"
{
	"0"
	{
		"path"		"${steam.replaceAll("\\", "\\\\")}"
	}
	"1"
	{
		"path"		"${library.replaceAll("\\", "\\\\")}"
		"apps"
		{
			"100"		"1234"
		}
	}
}
`,
    );
    await writeFile(
      path.join(library, "steamapps", "appmanifest_100.acf"),
      manifest(100, {
        name: "Example Game",
        installdir: "Example",
        StateFlags: "4",
      }),
    );
    await writeFile(
      path.join(library, "steamapps", "appmanifest_101.acf"),
      manifest(101, { name: "Stale Game", installdir: "Missing" }),
    );
    await writeFile(
      path.join(library, "steamapps", "appmanifest_102.acf"),
      manifest(102, {
        name: "Incomplete Game",
        installdir: "Downloading",
        StateFlags: "2",
      }),
    );
    const result = await detectInstalledGames({
      ...options,
      steamRoots: [steam, library, library],
    });
    expect(result.games).toHaveLength(1);
    expect(result.games[0]).toMatchObject({
      name: "Example Game",
      source: "steam",
      executablePath: null,
    });
    expect(result.launchers).toContain("Steam");
  });
  it("accepts numeric-looking Steam names and install directories", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "steamapps", "common", "1943"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "steamapps", "appmanifest_1943.acf"),
      manifest(1943, { name: "1943", installdir: "1943", StateFlags: "4" }),
    );
    const result = await detectInstalledGames({
      ...options,
      steamRoots: [root],
    });
    expect(result.games).toHaveLength(1);
    expect(result.games[0]).toMatchObject({ name: "1943", source: "steam" });
    expect(result.warnings).toEqual([]);
  });
  it("counts a malformed Steam manifest as a skipped record", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "steamapps", "common", "Fine"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "steamapps", "appmanifest_200.acf"),
      manifest(200, { name: "Fine Game", installdir: "Fine", StateFlags: "4" }),
    );
    await writeFile(
      path.join(root, "steamapps", "appmanifest_201.acf"),
      manifest(201, { name: "No Install Dir", StateFlags: "4" }),
    );
    const result = await detectInstalledGames({
      ...options,
      steamRoots: [root],
    });
    expect(result.games.map((game) => game.name)).toEqual(["Fine Game"]);
    expect(result.warnings).toContain(
      "Steam: skipped 1 invalid installation metadata record(s).",
    );
  });
  it("validates Epic executables and reports malformed metadata without inventing launch targets", async () => {
    const root = await fixture();
    const manifests = path.join(root, "Manifests");
    const install = path.join(root, "Game");
    await mkdir(manifests);
    await mkdir(install);
    await writeFile(path.join(install, "game.exe"), "fixture");
    await writeFile(path.join(root, "outside.exe"), "fixture");
    await writeFile(
      path.join(manifests, "good.item"),
      JSON.stringify({
        DisplayName: "Epic Game",
        InstallLocation: install,
        LaunchExecutable: "game.exe",
        bIsIncompleteInstall: false,
      }),
    );
    await writeFile(
      path.join(manifests, "escape.item"),
      JSON.stringify({
        DisplayName: "Bad Target",
        InstallLocation: install,
        LaunchExecutable: "../outside.exe",
      }),
    );
    await writeFile(path.join(manifests, "bad.item"), "{");
    const result = await detectInstalledGames({
      ...options,
      epicManifestRoots: [manifests],
    });
    expect(result.games).toHaveLength(1);
    expect(result.games[0]?.executablePath).toBe(
      path.join(install, "game.exe"),
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it("uses GOG install metadata and rejects absent installs", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "game.exe"), "fixture");
    const result = await detectInstalledGames({
      ...options,
      gogGames: [
        {
          name: "GOG Game",
          path: root,
          executablePath: path.join(root, "game.exe"),
        },
        { name: "Stale", path: path.join(root, "missing") },
      ],
    });
    expect(result.games).toHaveLength(1);
    expect(result.games[0]).toMatchObject({
      source: "gog",
      executablePath: path.join(root, "game.exe"),
    });
  });
});
