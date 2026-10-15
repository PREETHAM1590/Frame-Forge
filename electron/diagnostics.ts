import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { Redactor } from "./redact.js";
import type { Repository } from "./repository.js";
import { logFiles } from "./logger.js";
import type {
  BoostCapabilities,
  DiagnosticsGroup,
  FpsSummary,
  Hardware,
} from "../shared/contracts.js";
export const issueUrl =
  "https://github.com/PREETHAM1590/Frame-Forge/issues/new";
export const groupInfo: Record<
  DiagnosticsGroup,
  { label: string; description: string }
> = {
  app: {
    label: "App and Windows version",
    description: "Frameforge version, Electron version, Windows version/build.",
  },
  system: {
    label: "Hardware summary",
    description:
      "CPU, GPU and RAM models, driver versions, drive sizes. No serial numbers.",
  },
  booster: {
    label: "Booster configuration",
    description:
      "Booster settings and modes, and each game's mode with its folder shortened to <game dir>.",
  },
  sessions: {
    label: "Boost sessions",
    description:
      "The last 50 boost sessions with what each mechanism did and why.",
  },
  catalogue: {
    label: "Optimization history",
    description: "Optimizations applied, rolled back or failed.",
  },
  activity: {
    label: "Activity log",
    description: "The last 500 activity rows.",
  },
  fps: {
    label: "FPS summaries",
    description: "Saved Game Monitor summaries (averages only, no game names).",
  },
  capabilities: {
    label: "Capability report",
    description: "Which booster mechanisms are available here, and why not.",
  },
  errors: {
    label: "Recent errors",
    description: "Failed operations and the latest warnings and errors.",
  },
  logs: {
    label: "Log files",
    description: "main.log and helper.log with their rotations, redacted.",
  },
};
export const groupOrder = Object.keys(groupInfo) as DiagnosticsGroup[];
export interface BundleData {
  /** Plain JSON-like data per group; null when it could not be read. */
  data: Partial<Record<DiagnosticsGroup, unknown>>;
  logsDir: string;
  version: string;
  now?: Date;
}
export interface BundleFile {
  name: string;
  group: DiagnosticsGroup | "readme";
  text: string;
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
function errorLines(text: string, name: string) {
  return text
    .split("\n")
    .filter((l) => / (WARN|ERROR) +\[/.test(l))
    .map((l) => `${name}: ${l}`);
}
export function readme(
  groups: DiagnosticsGroup[],
  version: string,
  at: string,
): string {
  return [
    `Frameforge diagnostics - version ${version} - ${at}`,
    "",
    "What this is",
    "  A report you created on your own PC with Settings > Diagnostics > Export diagnostics.",
    "  Frameforge did not upload it and never uploads it. You decide whether to share it.",
    "",
    "What is inside",
    ...groups.map(
      (g) => `  - ${groupInfo[g].label}: ${groupInfo[g].description}`,
    ),
    "",
    "What was removed before it was saved",
    "  Your Windows user name and profile path (<USER>, <PROFILE>), the PC name (<PC>),",
    "  game install folders (shown as <game dir>\\<exe name>), email addresses, IP and MAC",
    "  addresses, serial numbers and usage-statistics session ids.",
    "  No registry export and no files from other apps are included.",
    "",
    "How to attach it to a GitHub issue",
    `  1. Open ${issueUrl} (or press "Report a problem" in Settings > Diagnostics).`,
    "  2. Describe what happened and what you expected.",
    "  3. Drag this .zip file into the comment box to attach it.",
    "  Look through the files first; you can delete anything you do not want to share.",
    "",
  ].join("\r\n");
}
/** Builds every file for the chosen groups. All text is redacted here, whatever the source did. */
export function buildBundle(
  input: BundleData,
  groups: DiagnosticsGroup[],
  redact: Redactor,
): BundleFile[] {
  const chosen = groupOrder.filter((g) => groups.includes(g));
  const at = (input.now ?? new Date()).toISOString();
  const files: BundleFile[] = [];
  const add = (group: DiagnosticsGroup, name: string, value: unknown) =>
    files.push({ name, group, text: redact(json(redact.deep(value))) });
  const logs = logFiles(input.logsDir);
  for (const g of chosen) {
    if (g === "logs") {
      for (const f of logs)
        files.push({ name: `logs/${f.name}`, group: g, text: redact(f.text) });
      if (!logs.length)
        files.push({
          name: "logs/README.txt",
          group: g,
          text: "No log files yet.\n",
        });
    } else if (g === "errors") {
      const lines = logs.flatMap((f) => errorLines(f.text, f.name)).slice(-100);
      add(g, "errors.json", {
        failedOperations: input.data.errors ?? [],
        logLines: lines.map((l) => redact(l)),
      });
    } else add(g, `${g}.json`, input.data[g] ?? null);
  }
  const body = [...files.map((f) => f.name), "manifest.json", "README.txt"];
  files.push({
    name: "manifest.json",
    group: "readme",
    text: json({
      app: "Frameforge",
      version: input.version,
      createdAt: at,
      groups: chosen,
      files: body,
    }),
  });
  files.push({
    name: "README.txt",
    group: "readme",
    text: redact(readme(chosen, input.version, at)),
  });
  return files;
}
// Minimal ZIP writer (deflate, UTF-8 names). Entries are small text files.
export function zip(files: { name: string; text: string }[], now = new Date()) {
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate =
    ((now.getFullYear() - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.text, "utf8");
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
/** The save dialog result must be a local absolute .zip path in an existing-looking folder; anything else is refused. */
export function validZipPath(
  chosen: unknown,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (typeof chosen !== "string" || chosen.length > 1024) return null;
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(chosen) || chosen.includes("\0")) return null;
  if (platform === "win32" && !/^[A-Za-z]:[\\/]/.test(chosen)) return null;
  const base = p.basename(chosen);
  if (!/\.zip$/i.test(base) || base.length <= 4) return null;
  return p.normalize(chosen);
}
/** Prefilled new-issue page: only the version and Windows build, nothing from this PC. */
export function reportUrl(version: string, windowsBuild: string): string {
  const clean = (s: string) => s.replace(/[^\w. -]/g, "").slice(0, 40);
  const body = [
    "**What happened?**",
    "",
    "**What did you expect?**",
    "",
    "**Steps to reproduce**",
    "",
    `Frameforge version: ${clean(version)}`,
    `Windows build: ${clean(windowsBuild)}`,
    "",
    "Please attach the diagnostics zip (Settings > Diagnostics > Export diagnostics).",
  ].join("\n");
  return `${issueUrl}?${new URLSearchParams({ title: "Bug: ", body, labels: "bug" })}`;
}
/** shell.openExternal is only ever given a URL that passes this. */
export const allowedIssueUrl = (url: string) =>
  url === issueUrl || url.startsWith(`${issueUrl}?`);
/** What the app gives the diagnostics flow; everything touching the desktop (dialogs, shell) lives behind this. */
export interface DiagnosticsHost {
  logsDir: string;
  redact: Redactor;
  /** Shows the native save dialog and writes the zip; the chosen file name, or null when cancelled. */
  saveZip(defaultName: string, data: Buffer): Promise<string | null>;
  openLogs(): Promise<boolean>;
  /** Receives only a URL that passed allowedIssueUrl. */
  openIssue(url: string): Promise<boolean>;
  /** Build facts (commit, date); never the analytics key. */
  build?: Record<string, string>;
}
export interface DiagnosticsSources {
  repo: Repository;
  hardware: () => Hardware;
  capabilities: () => Promise<BoostCapabilities | null>;
  supported: () => string[];
  fpsHistory: (gameId: string) => FpsSummary[];
  version: string;
  mode: "desktop" | "demo";
}
export async function collectData(
  src: DiagnosticsSources,
  host: DiagnosticsHost,
): Promise<BundleData> {
  const state = src.repo.state();
  const hw = src.hardware();
  const activity = src.repo.activity();
  const data: BundleData["data"] = {
    app: {
      frameforge: src.version,
      mode: src.mode,
      build: host.build ?? {},
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      windows: { description: hw.os, release: os.release() },
    },
    system: {
      source: hw.source,
      collectedAt: hw.collectedAt,
      cpu: hw.cpu,
      cores: hw.cores,
      gpu: hw.gpu,
      memoryBytes: hw.memoryBytes,
      drivers: hw.drivers,
      drives: hw.drives.map((d) => ({
        totalBytes: d.totalBytes,
        freeBytes: d.freeBytes,
      })),
      warnings: hw.warnings,
    },
    booster: {
      settings: state.settings,
      booster: state.booster,
      games: state.games.map((g) => ({
        source: g.source,
        profile: g.profile,
        boostMode: g.boostMode,
        executable: g.executablePath,
      })),
    },
    sessions: src.repo.boostSessions(50).map((s) => ({
      ...s,
      samples: undefined,
      sampleCount: s.samples.length,
    })),
    catalogue: activity.filter((a) => a.rollback).slice(0, 200),
    activity: activity.slice(0, 500),
    fps: state.games.flatMap((g) =>
      src.fpsHistory(g.id).map((s) => ({ ...s, gameName: undefined })),
    ),
    capabilities: {
      supportedWindowsChanges: src.supported(),
      booster: await src.capabilities().catch(() => null),
    },
    errors: activity
      .filter((a) => a.status === "failed" || a.status === "recovery-needed")
      .slice(0, 100)
      .map(({ at, label, status, message }) => ({
        at,
        label,
        status,
        message,
      })),
  };
  return { data, logsDir: host.logsDir, version: src.version };
}
export function preview(bundle: BundleFile[], groups = groupOrder) {
  return {
    groups: groups.map((id) => ({
      id,
      ...groupInfo[id],
      files: bundle
        .filter((f) => f.group === id)
        .map((f) => ({
          name: f.name,
          bytes: Buffer.byteLength(f.text),
          preview: f.text.slice(0, 5000),
        })),
    })),
    redactions: [
      "Windows user name -> <USER>, profile folder -> <PROFILE>, PC name -> <PC>",
      "Game folders -> <game dir>\\<exe name>",
      "Email addresses, IP and MAC addresses, serial numbers, usage-statistics session ids",
      "No registry dump and no files from other apps",
    ],
  };
}
