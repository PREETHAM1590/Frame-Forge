import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type RegistryRecord = { key: string; values: Record<string, string> };
export type RegistryQuery = (key: string) => Promise<RegistryRecord[]>;

const executeFile = promisify(execFile);

// Parses `reg query <key> /s`. Value names are lower-cased so parsers need not guess casing.
// REG_SZ and REG_EXPAND_SZ keep their text, REG_DWORD (0x..) becomes a decimal string.
export function parseRegOutput(stdout: string): RegistryRecord[] {
  const records: RegistryRecord[] = [];
  let record: RegistryRecord | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) {
      record = { key: line.trim(), values: {} };
      records.push(record);
      continue;
    }
    const value = /^\s+(.+?)\s+REG_(SZ|EXPAND_SZ|DWORD)(?:\s+(.*))?$/.exec(
      line,
    );
    if (!record || !value) continue;
    const text = (value[3] ?? "").trim();
    record.values[value[1]!.toLowerCase()] =
      value[2] === "DWORD" ? String(Number.parseInt(text, 16)) : text;
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
  try {
    const { stdout } = await executeFile(executable, ["query", key, "/s"], {
      windowsHide: true,
      shell: false,
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseRegOutput(stdout);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
};
