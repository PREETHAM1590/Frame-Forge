import os from "node:os";
export interface Identity {
  username: string[];
  profile: string[];
  machine: string[];
}
export interface GamePaths {
  path?: string | null;
  executablePath?: string | null;
}
export type Redactor = {
  (text: string): string;
  /** Redacts every string in a JSON-like value, and every value under a serial/session-id style key. */
  deep<T>(value: T): T;
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sep = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .map(esc)
    .join("[\\\\/]+");
const word = (name: string) => `(?<![A-Za-z0-9])${esc(name)}(?![A-Za-z0-9])`;
const secretKey =
  /serial|guid|uuid|mac[ _-]?address|session[ _-]?id|app[ _-]?key/i;
/** This PC's identity, as seen by the current process. */
export function currentIdentity(): Identity {
  const list = (...v: (string | undefined)[]) => [
    ...new Set(v.filter((x): x is string => !!x && x.length > 0)),
  ];
  let user: string | undefined;
  try {
    user = os.userInfo().username;
  } catch {
    /* no user record */
  }
  return {
    username: list(user, process.env.USERNAME),
    profile: list(os.homedir(), process.env.USERPROFILE),
    machine: list(os.hostname(), process.env.COMPUTERNAME),
  };
}
// Placeholders such as <USER> must survive a second pass (log write, then export).
const swap = (re: RegExp, token: string) => (text: string) =>
  text.replace(re, (m: string, ...rest: unknown[]) => {
    const offset = rest.find((r) => typeof r === "number") as number;
    return text[offset - 1] === "<" && text[offset + m.length] === ">"
      ? m
      : token;
  });
/**
 * Builds the redaction used for log lines and the diagnostics export:
 * user name, profile path, PC name, game install paths, emails, IP and MAC addresses, serial numbers, Aptabase key and session ids.
 */
export function makeRedactor(
  identity: Identity,
  games: () => GamePaths[] = () => [],
): Redactor {
  const profiles = identity.profile.filter((p) => p.length > 3);
  const profileRe = profiles.length
    ? new RegExp(`(?:file:///)?(?:${profiles.map(sep).join("|")})`, "gi")
    : null;
  const names = (v: string[], token: string) =>
    v.length
      ? swap(new RegExp(v.map(word).join("|"), "gi"), token)
      : (t: string) => t;
  const user = names(identity.username, "<USER>");
  const pc = names(identity.machine, "<PC>");
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const gamePaths = (text: string) => {
    let out = text;
    const list = games()
      .flatMap((g) => [
        g.executablePath ? { p: g.executablePath, exe: true } : null,
        g.path ? { p: g.path, exe: false } : null,
      ])
      .filter((x): x is { p: string; exe: boolean } => !!x && x.p.length > 3)
      .sort((a, b) => b.p.length - a.p.length);
    for (const { p, exe } of list)
      out = out.replace(
        new RegExp(sep(p), "gi"),
        exe ? `<game dir>\\${base(p).replace(/\$/g, "$$$$")}` : "<game dir>",
      );
    return out;
  };
  const steps: ((t: string) => string)[] = [
    gamePaths,
    // Emails first so a name in an address is gone before the user-name pass.
    (t) => t.replace(/[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/g, "<EMAIL>"),
    (t) => (profileRe ? t.replace(profileRe, "<PROFILE>") : t),
    // The PC name first: it often contains the user name.
    pc,
    user,
    // Any other game-like executable path outside the Windows folder.
    (t) =>
      t.replace(
        /(?![A-Za-z]:\\Windows\\)[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]+\.exe)/gi,
        "<game dir>\\$1",
      ),
    (t) =>
      t.replace(
        /\b[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}\b/gi,
        "<MAC>",
      ),
    (t) =>
      t
        .replace(/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, "<IP>")
        .replace(
          /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi,
          (m) => (m === "::" ? m : "<IP>"),
        ),
    (t) =>
      t.replace(
        /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d|\.\d)/g,
        "<IP>",
      ),
    (t) => t.replace(/\bA-(?:EU|US|DEV|SH)-\d+\b/g, "<APP-KEY>"),
    (t) =>
      t.replace(
        /([A-Za-z_]*session[ _-]?id["']?\s*[:=]\s*["']?)(?!<)[^\s"',;}\]]+/gi,
        "$1<SESSION>",
      ),
    // Aptabase session ids are 17 to 19 digit numbers.
    (t) => t.replace(/(?<![\d.])\d{17,19}(?![\d.])/g, "<SESSION>"),
    (t) =>
      t.replace(
        /((?:[A-Za-z_]*(?:serial(?:[ _-]?number)?|guid|uuid)|s\/n)["']?\s*[:=]\s*["']?)(?!<)[^\s"',;}\]]+/gi,
        "$1<SERIAL>",
      ),
  ];
  const redact = ((text: string) =>
    steps.reduce((t, step) => step(t), text)) as Redactor;
  const deep = (value: unknown, key = ""): unknown => {
    if (typeof value === "string")
      return secretKey.test(key) && value
        ? /session/i.test(key)
          ? "<SESSION>"
          : "<SERIAL>"
        : redact(value);
    if (typeof value === "number" && secretKey.test(key))
      return /session/i.test(key) ? "<SESSION>" : "<SERIAL>";
    if (Array.isArray(value)) return value.map((v) => deep(v, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [redact(k), deep(v, k)]),
      );
    return value;
  };
  redact.deep = deep as Redactor["deep"];
  return redact;
}
