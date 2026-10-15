import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
export type Level = "info" | "warn" | "error";
export type LogFn = (level: Level, tag: string, message: unknown) => void;
export const noLog: LogFn = () => {};
export const maxLogBytes = 2 * 1024 * 1024;
export const keptRotations = 3;
const maxLine = 8000;
/** One size-capped text log: name.log, rotated to name.1.log .. name.3.log. Never throws; every line is redacted before it is written. */
export class RotatingLog {
  private size: number | null = null;
  constructor(
    readonly dir: string,
    readonly name: string,
    private redact: (text: string) => string,
    private maxBytes = maxLogBytes,
    private keep = keptRotations,
  ) {}
  private file(n = 0) {
    return path.join(
      this.dir,
      n ? `${this.name}.${n}.log` : `${this.name}.log`,
    );
  }
  private rotate() {
    rmSync(this.file(this.keep), { force: true });
    for (let n = this.keep - 1; n >= 0; n--)
      if (existsSync(this.file(n))) renameSync(this.file(n), this.file(n + 1));
    this.size = 0;
  }
  write: LogFn = (level, tag, message) => {
    try {
      const raw =
        message instanceof Error
          ? (message.stack ?? message.message)
          : String(message);
      const text = raw.length > maxLine ? raw.slice(0, maxLine) + "..." : raw;
      const line =
        this.redact(
          `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${text.replace(/\r?\n/g, "\n    ")}`,
        ) + "\n";
      const bytes = Buffer.byteLength(line);
      mkdirSync(this.dir, { recursive: true });
      this.size ??= existsSync(this.file()) ? statSync(this.file()).size : 0;
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.file(), line);
      this.size += bytes;
    } catch {
      /* logging must never break the app */
    }
  };
}
export function createLogs(dir: string, redact: (text: string) => string) {
  return {
    dir,
    main: new RotatingLog(dir, "main", redact).write,
    helper: new RotatingLog(dir, "helper", redact).write,
  };
}
/** The log files on disk: main.log, main.1.log, ..., helper.log, ... */
export function logFiles(dir: string): { name: string; text: string }[] {
  try {
    return readdirSync(dir)
      .filter((f) => /^(main|helper)(\.\d)?\.log$/.test(f))
      .sort()
      .map((name) => ({
        name,
        text: readFileSync(path.join(dir, name), "utf8"),
      }));
  } catch {
    return [];
  }
}
