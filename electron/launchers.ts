import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { RegistryRecord } from "./registry.js";

// Pure parsers: file text, buffers or registry records in, found games out. No I/O.
export type Found = { name: string; installPath: string; executable?: string };

const leaf = (key: string) => key.slice(key.lastIndexOf("\\") + 1);
const unquote = (value: string) => value.replace(/^"(.*)"$/, "$1");
const decodeXml = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export function isSteamNonGame(appId: string, name: string): boolean {
  return (
    appId === "228980" ||
    /^(Steamworks Common Redistributables|Proton|Steam Linux Runtime)/i.test(
      name,
    )
  );
}

export function isEpicNonGame(categories: string[] | undefined): boolean {
  return (categories ?? []).some((category) =>
    /plugins|engines/i.test(category),
  );
}

export function parseGog(records: RegistryRecord[]): Found[] {
  return records.flatMap(({ values }) =>
    values.gamename && values.path
      ? [
          {
            name: values.gamename,
            installPath: values.path,
            ...(values.exe ? { executable: unquote(values.exe) } : {}),
          },
        ]
      : [],
  );
}

const eaInfrastructure =
  /^(EA Games|EA (app|desktop|core|help|link|installer)|Origin|Electronic Arts)$/i;
export function parseEa(records: RegistryRecord[]): Found[] {
  return records.flatMap(({ key, values }) =>
    values["install dir"] && !eaInfrastructure.test(leaf(key))
      ? [{ name: leaf(key), installPath: values["install dir"] }]
      : [],
  );
}

export function parseUbisoft(
  installs: RegistryRecord[],
  uninstalls: RegistryRecord[],
): Found[] {
  const names = new Map(
    uninstalls.map(({ key, values }) => [leaf(key), values.displayname]),
  );
  return installs.flatMap(({ key, values }) => {
    const dir = values.installdir;
    if (!dir) return [];
    const name =
      names.get(`Uplay Install ${leaf(key)}`) ||
      path.win32.basename(dir.replace(/[\\/]+$/, ""));
    return name ? [{ name, installPath: dir }] : [];
  });
}

export function parseBattlenet(uninstalls: RegistryRecord[]): Found[] {
  return uninstalls.flatMap(({ values }) =>
    values.publisher === "Blizzard Entertainment" &&
    values.displayname &&
    values.installlocation &&
    !/^Battle\.net$/i.test(values.displayname)
      ? [{ name: values.displayname, installPath: values.installlocation }]
      : [],
  );
}

export function parseRockstar(
  records: RegistryRecord[],
  uninstalls: RegistryRecord[],
): Found[] {
  const found: Found[] = [];
  for (const { key, values } of records)
    if (values.installfolder && !/^(Launcher|Social Club)$/i.test(leaf(key)))
      found.push({ name: leaf(key), installPath: values.installfolder });
  for (const { values } of uninstalls)
    if (
      values.publisher === "Rockstar Games" &&
      values.displayname &&
      values.installlocation &&
      !/launcher|social club/i.test(values.displayname)
    )
      found.push({
        name: values.displayname,
        installPath: values.installlocation,
      });
  return found;
}

const publishers =
  /^(Blizzard|Riot|Rockstar|Electronic Arts|Ubisoft|Bethesda|Activision|CD PROJEKT|Square Enix|Bandai Namco|SEGA|Capcom|Paradox)/i;
const notAGame =
  /\b(vanguard|client|launcher|redistributable|runtime|driver|updater|bootstrapper|social club|battle\.net|ea app|ea desktop|origin|ubisoft connect|anti-?cheat)\b/i;
export function parseUninstallHeuristic(uninstalls: RegistryRecord[]): Found[] {
  return uninstalls.flatMap(({ key, values }) => {
    const name = values.displayname?.trim();
    const install = values.installlocation;
    if (!name || !install || notAGame.test(name)) return [];
    const trusted =
      publishers.test(values.publisher ?? "") ||
      /^Steam App \d+$/.test(leaf(key));
    return trusted ? [{ name, installPath: install }] : [];
  });
}

// X:\.GamingRoot = "RGBX", uint32 LE count, then UTF-16LE NUL-terminated folder names.
export function parseGamingRoot(buffer: Buffer): string[] {
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "RGBX")
    return [];
  const count = Math.min(buffer.readUInt32LE(4), 16);
  const names: string[] = [];
  let offset = 8;
  for (let index = 0; index < count && offset < buffer.length; index++) {
    let end = offset;
    while (
      end + 1 < buffer.length &&
      (buffer[end] !== 0 || buffer[end + 1] !== 0)
    )
      end += 2;
    names.push(buffer.toString("utf16le", offset, end));
    offset = end + 2;
  }
  return names.filter(
    (name) =>
      name &&
      name
        .split(/[\\/]/)
        .every((part) => part && part !== "." && part !== "..") &&
      !name.includes(":"),
  );
}

// The attributes span several lines in real files, so every gap allows \s (newlines included).
export function parseMicrosoftGameConfig(
  text: string,
  folderName: string,
): { name: string; executable?: string } {
  const title = /DefaultDisplayName\s*=\s*"([^"]*)"/.exec(text)?.[1];
  const list = /<ExecutableList[\s>][\s\S]*?<\/ExecutableList>/.exec(text)?.[0];
  const executable = list
    ? /<Executable\s[^>]*?\bName\s*=\s*"([^"]+)"/.exec(list)?.[1]
    : undefined;
  const name = title ? decodeXml(title).trim() : "";
  return {
    name: !name || name.startsWith("ms-resource:") ? folderName : name,
    ...(executable ? { executable: decodeXml(executable) } : {}),
  };
}

const riotNames: Record<string, string> = {
  valorant: "VALORANT",
  league_of_legends: "League of Legends",
  teamfighttactics: "Teamfight Tactics",
  bacon: "Legends of Runeterra",
};
// folderName is "<product>.<patchline>", for example "valorant.live".
export function parseRiotSettings(
  text: string,
  folderName: string,
): Found | null {
  const install = /^\s*product_install_full_path:\s*"([^"]+)"/m.exec(text)?.[1];
  if (!install) return null;
  const [product = "", patchline] = folderName.split(".");
  const name =
    riotNames[product] ??
    product
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  if (!name) return null;
  return {
    name: patchline === "pbe" ? `${name} (PBE)` : name,
    installPath: install,
  };
}

export const maxMetadataBytes = 1024 * 1024;
export function parseItchReceipt(buffer: Buffer): string | null {
  if (buffer.length > maxMetadataBytes) throw new Error("Receipt too large");
  const receipt = JSON.parse(
    gunzipSync(buffer, { maxOutputLength: maxMetadataBytes }).toString("utf8"),
  ) as { game?: { title?: unknown } };
  const title = receipt.game?.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

const notTheGame =
  /^(unins|setup|install|vc_?redist|dxsetup|crashreport|unitycrashhandler|crashpad|ue4prereq|dotnet|easyanticheat|be(service|_setup)|launcher_?helper)/i;
// The largest .exe that is not an installer, crash reporter or anti-cheat helper.
export function pickGameExecutable(
  files: { file: string; size: number }[],
): string | undefined {
  return files
    .filter(
      ({ file }) =>
        file.toLowerCase().endsWith(".exe") &&
        !notTheGame.test(path.win32.basename(file)),
    )
    .sort((a, b) => b.size - a.size)[0]?.file;
}

export type StorePackage = { name: string | null; installLocation: string };
// JSON from the Store package script: an array of { name, installLocation }.
export function parseStorePackages(text: string): StorePackage[] {
  if (!text.trim()) return [];
  const data = JSON.parse(text) as unknown;
  return (Array.isArray(data) ? data : [data]).flatMap((entry: unknown) => {
    const { name, installLocation } = (entry ?? {}) as Record<string, unknown>;
    return typeof installLocation === "string" && installLocation
      ? [
          {
            name: typeof name === "string" && name.trim() ? name.trim() : null,
            installLocation,
          },
        ]
      : [];
  });
}
