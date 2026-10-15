// "Close or pause apps while gaming": groups running processes into apps and suggests the heavy, non-essential ones.
// Pure and shared by the Game Mode page and Smart mode, so the list a person sees is the list Smart mode would use.
import {
  isProtectedImage,
  type BoosterConfig,
  type Game,
  type RunningProcess,
} from "./contracts.js";

export type BackgroundAction = BoosterConfig["background"][number]["action"];
export interface AppGroup {
  /** Lower-case image name, the identity of the app. */
  key: string;
  image: string;
  /** Windows' file name without .exe, shown as the app name. */
  name: string;
  processes: number;
  ramBytes: number;
  cpuPercent: number;
  path: string | null;
  protected: boolean;
}
export interface Suggestion {
  suggested: boolean;
  action: BackgroundAction;
  kind: string;
  reason: string;
  /** Set when the app must not be paused or closed automatically; the person can still lower it by hand. */
  blocked?: string;
}

const imageOk = /^[\w .()-]{1,64}\.exe$/i;
export const nameOf = (image: string) => image.replace(/\.exe$/i, "");

export function groupProcesses(
  processes: readonly RunningProcess[],
): AppGroup[] {
  const map = new Map<string, AppGroup>();
  for (const p of processes) {
    const key = p.image.toLowerCase();
    const old = map.get(key);
    if (old) {
      old.processes++;
      old.ramBytes += p.workingSetBytes ?? 0;
      old.cpuPercent = Math.min(100, old.cpuPercent + (p.cpuPercent ?? 0));
      old.protected ||= p.protected;
    } else
      map.set(key, {
        key,
        image: p.image,
        name: nameOf(p.image),
        processes: 1,
        ramBytes: p.workingSetBytes ?? 0,
        cpuPercent: p.cpuPercent ?? 0,
        path: p.path ?? null,
        protected: p.protected,
      });
  }
  return [...map.values()];
}

// Things that must never be paused or closed for the person: voice and chat in a call, audio, input and peripheral software,
// overlays the person may be using, security software, anti-cheat, the game's own launcher, and Frameforge itself.
const blocks: [RegExp, string][] = [
  [/^frameforge|^electron$/i, "Frameforge itself"],
  [
    /^(discord|discordptb|discordcanary|teamspeak|ts3client|mumble|zoom|skype|guilded)\b/i,
    "voice chat: it might be in a call",
  ],
  [
    /voicemeeter|nahimic|realtek|rtkaudio|waves|sonar|steelseriesgg|equalizerapo|audiodg|obs(64)?$|streamlabs|medal|shadowplay|nvcontainer|nvidia share|nvsphelper|nvidia overlay|rtss|msiafterburner|gamebar|radeonsoftware|amdow|geforce/i,
    "audio, capture or overlay software you may be using",
  ],
  [
    /lghub|logi|razer|synapse|icue|corsair|steelseries|wooting|wootility|armoury|nitrosense|predatorsense|vantage|omen|alienware|ghub|hyperx|roccat|asus|msi center|mysticlight|signalrgb|openrgb/i,
    "keyboard, mouse or laptop control software",
  ],
  [
    /defender|msmpeng|antimalware|mbam|malwarebytes|avast|avg|norton|mcafee|kaspersky|bitdefender|eset|sophos|vgc|vgtray|easyanticheat|beservice|faceit|battleye/i,
    "security or anti-cheat software",
  ],
  [
    /^(steam|epicgameslauncher|galaxyclient|riotclientservices|riotclientux|riot client|battle\.net|origin|eadesktop|ubisoftconnect|upc|xboxpcapp|gamingservices)\b/i,
    "game launcher: games depend on it running",
  ],
];
export const neverTouch = (image: string): string | null =>
  isProtectedImage(image)
    ? "Protected system, security or anti-cheat program."
    : (blocks.find(([pattern]) => pattern.test(nameOf(image)))?.[1] ?? null);

const MB = 1024 * 1024;
type Kind = [RegExp, BackgroundAction, string, string];
const kinds: Kind[] = [
  [
    /^(chrome|msedge|firefox|opera|opera_gx|brave|vivaldi|arc|iexplore)$/i,
    "lower",
    "browser",
    "Browsers hold a lot of memory and wake up often. Lowering priority is safe; close it to free the memory.",
  ],
  [
    /^(onedrive|dropbox|googledrivefs|googledrive|megasync|icloud\w*|boxsync|nextcloud)$/i,
    "suspend",
    "cloud sync",
    "Sync uploads and downloads in the background; pausing it only delays syncing.",
  ],
  [
    /update|updater|\bsetup\b|installer|telemetry|compattelrunner/i,
    "suspend",
    "updater",
    "Updaters use disk, network and CPU in the background and can wait.",
  ],
  [
    /(steam|epic|origin|ea|galaxy|ubisoft|battle\.?net|riot)\w*webhelper|cefsharp\.browsersubprocess|crashhandler/i,
    "lower",
    "launcher web helper",
    "Launchers run a small web browser inside; it is not needed while you play.",
  ],
  [
    /^(slack|ms-teams|teams|telegram|whatsapp|signal|skype|element|viber|line)$/i,
    "lower",
    "chat app",
    "Chat apps stay awake for messages. Lowering priority keeps notifications working.",
  ],
  [
    /^(code|code - insiders|cursor|devenv|idea64|pycharm64|webstorm64|chatgpt|claude|notion|obsidian|figma|adobe\w*|photoshop|illustrator|premiere\w*|afterfx|lightroom|docker desktop|node)$/i,
    "lower",
    "heavy desktop app",
    "A large app you are probably not using while gaming. Lowering priority is safe; close it to free memory.",
  ],
];

export function classifyApp(
  group: AppGroup,
  ctx: { gameImage?: string; gameSource?: Game["source"] } = {},
): Suggestion {
  const blocked = neverTouch(group.image);
  const base = { action: "lower" as BackgroundAction, kind: "app" };
  if (!imageOk.test(group.image) || group.protected)
    return {
      suggested: false,
      ...base,
      reason: "Protected or not selectable.",
      blocked: "Protected system, security or anti-cheat program.",
    };
  if (ctx.gameImage && group.key === ctx.gameImage.toLowerCase())
    return {
      suggested: false,
      ...base,
      reason: "This is the game.",
      blocked: "The running game.",
    };
  const name = nameOf(group.image);
  const match = kinds.find(([pattern]) => pattern.test(name));
  // A launcher's web helper is blocked only for the launcher hosting the game; the launcher check above blocks the launcher itself.
  const helperOfLauncher =
    match?.[2] === "launcher web helper" &&
    ctx.gameSource &&
    new RegExp(
      ctx.gameSource === "battlenet" ? "battle" : ctx.gameSource,
      "i",
    ).test(name);
  if (blocked && match?.[2] !== "launcher web helper")
    return { suggested: false, ...base, reason: blocked, blocked };
  if (helperOfLauncher)
    return {
      suggested: false,
      ...base,
      kind: match![2],
      reason: "Its launcher is running this game.",
      blocked: "Its launcher is running this game.",
    };
  if (!match)
    return {
      suggested: false,
      ...base,
      reason: "Not recognised as safe to pause. You can still choose it.",
    };
  const [, action, kind, why] = match;
  const heavy =
    group.ramBytes >= 250 * MB ||
    group.cpuPercent >= 2 ||
    kind === "cloud sync" ||
    kind === "updater";
  return {
    suggested: heavy,
    action,
    kind,
    reason: heavy
      ? why
      : `${why} It is small right now, so it is not suggested.`,
  };
}

export interface BackgroundRow extends AppGroup, Suggestion {
  /** Currently chosen in the saved list (or, when nothing was saved, suggested). */
  selected: boolean;
  /** The saved action when chosen, else the suggested one. */
  chosenAction: BackgroundAction;
}

/** What the list on screen shows: running apps with their suggestion, and saved apps that are not running now. */
export function backgroundRows(
  processes: readonly RunningProcess[],
  saved: BoosterConfig["background"],
  chosen: boolean,
  ctx: { gameImage?: string; gameSource?: Game["source"] } = {},
): BackgroundRow[] {
  const savedBy = new Map(saved.map((s) => [s.image.toLowerCase(), s.action]));
  const rows: BackgroundRow[] = groupProcesses(processes)
    .filter((g) => !g.protected || savedBy.has(g.key))
    .map((g) => {
      const s = classifyApp(g, ctx);
      const mine = savedBy.get(g.key);
      return {
        ...g,
        ...s,
        selected: chosen ? mine !== undefined : s.suggested && !s.blocked,
        chosenAction: mine ?? s.action,
      };
    });
  // Saved apps that are not running now still show, so they can be removed.
  for (const [key, action] of savedBy)
    if (!rows.some((r) => r.key === key)) {
      const image = saved.find((s) => s.image.toLowerCase() === key)!.image;
      rows.push({
        key,
        image,
        name: nameOf(image),
        processes: 0,
        ramBytes: 0,
        cpuPercent: 0,
        path: null,
        protected: false,
        suggested: false,
        action,
        kind: "saved",
        reason: "Not running right now.",
        selected: true,
        chosenAction: action,
      });
    }
  return rows.sort(
    (a, b) =>
      Number(b.selected) - Number(a.selected) ||
      Number(b.suggested) - Number(a.suggested) ||
      b.ramBytes - a.ramBytes ||
      a.name.localeCompare(b.name),
  );
}

/** The rules Smart mode applies when nobody chose a list: the suggested apps among those running now. */
export function suggestedRules(
  processes: readonly RunningProcess[],
  ctx: { gameImage?: string; gameSource?: Game["source"] } = {},
  limit = 20,
): BoosterConfig["background"] {
  return backgroundRows(processes, [], false, ctx)
    .filter((r) => r.selected && r.processes > 0)
    .slice(0, limit)
    .map((r) => ({ image: r.image, action: r.chosenAction }));
}

/** Which list applies to a game: its own override, else the person's saved list, else the suggested apps. */
export function effectiveBackground(
  game: Pick<Game, "background"> | undefined,
  config: Pick<BoosterConfig, "background" | "backgroundChosen">,
  processes: readonly RunningProcess[],
  ctx: { gameImage?: string; gameSource?: Game["source"] } = {},
): {
  rules: BoosterConfig["background"];
  source: "game" | "saved" | "suggested";
} {
  if (game?.background) return { rules: game.background, source: "game" };
  if (config.backgroundChosen || config.background.length)
    return { rules: config.background, source: "saved" };
  return { rules: suggestedRules(processes, ctx), source: "suggested" };
}

/** Plain-language totals for a set of rows. Closing frees memory; pausing or lowering only stops competing CPU use. */
export function totals(rows: readonly BackgroundRow[]) {
  const picked = rows.filter((r) => r.selected && r.processes > 0);
  const closeBytes = picked
    .filter((r) => r.chosenAction === "close")
    .reduce((s, r) => s + r.ramBytes, 0);
  const heldBytes = picked
    .filter((r) => r.chosenAction !== "close")
    .reduce((s, r) => s + r.ramBytes, 0);
  const cpu = picked.reduce((s, r) => s + r.cpuPercent, 0);
  return { count: picked.length, closeBytes, heldBytes, cpuPercent: cpu };
}
