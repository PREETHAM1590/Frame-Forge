import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type RegistryRecord = { key: string; values: Record<string, string> };
export type RegistryQuery = (key: string) => Promise<RegistryRecord[]>;

const executeFile = promisify(execFile);

// `reg export` writes UTF-16LE with a BOM whatever the console code page is, unlike `reg query`
// whose piped output is OEM-encoded and garbles every non-ASCII name or path.
export function decodeRegFile(buffer: Buffer): string {
  return buffer[0] === 0xff && buffer[1] === 0xfe
    ? buffer.toString("utf16le", 2)
    : buffer.toString("latin1");
}

const unescape = (text: string) => text.replace(/\\(["\\])/g, "$1");
const utf16 = (hex: string) =>
  Buffer.from(hex.split(",").map((byte) => Number.parseInt(byte, 16)))
    .toString("utf16le")
    .replace(/\0+$/, "");

// Parses .reg text. Value names are lower-cased so parsers need not guess casing.
// Strings and REG_EXPAND_SZ/REG_SZ hex keep their text, dword becomes a decimal string, the rest is ignored.
export function parseRegExport(text: string): RegistryRecord[] {
  const records: RegistryRecord[] = [];
  let record: RegistryRecord | undefined;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!;
    // Long hex values continue on the next line after a trailing backslash.
    while (line.endsWith("\\") && index + 1 < lines.length)
      line = line.slice(0, -1) + lines[++index]!.trim();
    const key = /^\[(HKEY_[^\]]+)\]$/.exec(line);
    if (key) {
      record = { key: key[1]!, values: {} };
      records.push(record);
      continue;
    }
    const value = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(line);
    if (!record || !value) continue;
    const data = value[2]!;
    const name = unescape(value[1]!).toLowerCase();
    if (data.startsWith('"') && data.endsWith('"') && data.length >= 2)
      record.values[name] = unescape(data.slice(1, -1));
    else if (data.startsWith("dword:"))
      record.values[name] = String(Number.parseInt(data.slice(6), 16));
    else if (/^hex\([12]\):/.test(data))
      record.values[name] = utf16(data.slice(data.indexOf(":") + 1));
  }
  return records;
}

// reg.exe receives fixed keys through an argument array, never renderer text or a shell.
// A missing key (exit code 1) is an empty result; every other failure throws.
export const queryRegistry: RegistryQuery = async (key) => {
  if (process.platform !== "win32") return [];
  const executable = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "reg.exe",
  );
  const file = path.join(os.tmpdir(), `frameforge-${randomUUID()}.reg`);
  try {
    await executeFile(executable, ["export", key, file, "/y"], {
      windowsHide: true,
      shell: false,
      timeout: 10000,
    });
    if ((await stat(file)).size > 64 * 1024 * 1024)
      throw new Error("Registry export too large");
    return parseRegExport(decodeRegFile(await readFile(file)));
  } catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  } finally {
    await rm(file, { force: true });
  }
};
