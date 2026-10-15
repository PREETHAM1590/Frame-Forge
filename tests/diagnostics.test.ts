import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { makeRedactor } from "../electron/redact";
import { RotatingLog, maxLogBytes } from "../electron/logger";
import {
  allowedIssueUrl,
  buildBundle,
  issueUrl,
  reportUrl,
  validZipPath,
  zip,
  type DiagnosticsHost,
} from "../electron/diagnostics";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";
import { AppService } from "../electron/service";
import { diagnosticsGroups } from "../shared/contracts";

const identity = {
  username: ["alice"],
  profile: ["C:\\Users\\alice"],
  machine: ["ALICE-PC"],
};
const games = [
  {
    path: "D:\\Games\\Cool Game",
    executablePath: "D:\\Games\\Cool Game\\bin\\cool.exe",
  },
];
const redact = makeRedactor(identity, () => games);

describe("redaction", () => {
  it("replaces the user name, profile path and PC name", () => {
    expect(redact("C:\\Users\\alice\\AppData\\Roaming\\Frameforge")).toBe(
      "<PROFILE>\\AppData\\Roaming\\Frameforge",
    );
    expect(redact("c:/users/ALICE/Documents/x.txt")).toBe(
      "<PROFILE>/Documents/x.txt",
    );
    expect(redact("file:///C:/Users/alice/x")).toBe("<PROFILE>/x");
    expect(redact("owner ALICE, host alice-pc")).toBe(
      "owner <USER>, host <PC>",
    );
    expect(redact("malice and alicia")).toBe("malice and alicia");
  });
  it("shortens game install paths to <game dir>\\<exe name>", () => {
    expect(redact("Started D:\\Games\\Cool Game\\bin\\cool.exe now")).toBe(
      "Started <game dir>\\cool.exe now",
    );
    expect(redact("scan D:\\Games\\Cool Game\\saves")).toBe(
      "scan <game dir>\\saves",
    );
    expect(redact("E:\\Other\\Place\\other game\\run.exe")).toBe(
      "<game dir>\\run.exe",
    );
    expect(redact("C:\\Windows\\System32\\rstrui.exe")).toBe(
      "C:\\Windows\\System32\\rstrui.exe",
    );
  });
  it("removes emails, IP and MAC addresses, serials and session ids", () => {
    const text = [
      "mail bob.smith+x@example.co.uk end",
      "ip 192.168.1.20 and 10.0.0.255",
      "v6 fe80::1ff:fe23:4567:890a and 2001:db8:0:0:0:0:0:1",
      "mac 00:1A:2b:3C:4d:5E / 00-1a-2b-3c-4d-5e",
      "SerialNumber: ABC123XYZ",
      '{"BaseBoardSerialNumber":"ZZ99-77"}',
      "MachineGuid=4f9d1c2e-1111-2222-3333-444455556666",
      "sessionId: 169876543210987654",
      "key A-EU-1234567890 loose id 169876543210987655",
    ].join("\n");
    const out = redact(text);
    for (const leak of [
      "bob.smith",
      "example.co.uk",
      "192.168",
      "10.0.0.255",
      "fe80",
      "2001:db8",
      "00:1A",
      "00-1a",
      "ABC123XYZ",
      "ZZ99",
      "4f9d1c2e",
      "1698765432",
      "A-EU-",
    ])
      expect(out, leak).not.toContain(leak);
    expect(out).toContain("<EMAIL>");
    expect(out).toContain("<IP>");
    expect(out).toContain("<MAC>");
    expect(out).toContain("<SERIAL>");
    expect(out).toContain("<SESSION>");
    expect(out).toContain("<APP-KEY>");
  });
  it("keeps versions, times and ordinary text readable", () => {
    const text =
      "Windows 10.0.26300 driver 31.0.15.5222 at 2026-10-15T12:30:45.123Z std::vector ok";
    expect(redact(text)).toBe(text);
  });
  it("is stable when applied twice, even for names that look like placeholders", () => {
    const odd = makeRedactor({
      username: ["user"],
      profile: [],
      machine: ["pc"],
    });
    const once = odd("user on pc at C:\\Users\\user");
    expect(once).toBe("<USER> on <PC> at C:\\Users\\<USER>");
    expect(odd(once)).toBe(once);
    expect(redact(redact("C:\\Users\\alice a@b.io"))).toBe(
      redact("C:\\Users\\alice a@b.io"),
    );
  });
  it("redacts values under secret-looking keys in structured data", () => {
    const out = redact.deep({
      serialNumber: "SN-1",
      nested: [{ sessionId: 42, note: "alice at ALICE-PC" }],
      cpu: "Ryzen 7",
    });
    expect(out).toEqual({
      serialNumber: "<SERIAL>",
      nested: [{ sessionId: "<SESSION>", note: "<USER> at <PC>" }],
      cpu: "Ryzen 7",
    });
  });
});

describe("rotating logs", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "ff-logs-"));
  it("caps each file, keeps 3 rotations and drops older ones", () => {
    const d = dir();
    const log = new RotatingLog(d, "main", redact, 600, 3).write;
    for (let i = 0; i < 60; i++)
      log("info", "t", `line ${i} ${"x".repeat(40)}`);
    const files = readdirSync(d).sort();
    expect(files).toEqual([
      "main.1.log",
      "main.2.log",
      "main.3.log",
      "main.log",
    ]);
    for (const f of files)
      expect(statSync(path.join(d, f)).size).toBeLessThanOrEqual(600);
    // The newest line is in the current file, the oldest are gone.
    expect(readFileSync(path.join(d, "main.log"), "utf8")).toContain("line 59");
    const all = files
      .map((f) => readFileSync(path.join(d, f), "utf8"))
      .join("");
    expect(all).not.toContain("line 0 ");
  });
  it("defaults to 2 MB per file", () => {
    expect(maxLogBytes).toBe(2 * 1024 * 1024);
  });
  it("writes ISO timestamps and levels, redacted at write time", () => {
    const d = dir();
    const log = new RotatingLog(d, "main", redact).write;
    log("error", "ipc", "alice failed on ALICE-PC at 10.1.2.3 mail a@b.io");
    log("warn", "x", new Error("boom in C:\\Users\\alice\\x"));
    const text = readFileSync(path.join(d, "main.log"), "utf8");
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR \[ipc\] /);
    expect(text).toContain("WARN  [x] Error: boom in <PROFILE>");
    for (const leak of ["alice", "ALICE", "10.1.2.3", "a@b.io"])
      expect(text, leak).not.toContain(leak);
  });
  it("never throws when the folder cannot be written", () => {
    const log = new RotatingLog("\0:invalid", "main", redact).write;
    expect(() => log("info", "t", "x")).not.toThrow();
  });
});

// Reads a zip back through its central directory.
function unzip(buffer: Buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buffer.readUInt32LE(at)).toBe(0x02014b50);
    const csize = buffer.readUInt32LE(at + 20);
    const nameLen = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const raw = zlib.inflateRawSync(buffer.subarray(dataAt, dataAt + csize));
    expect(zlib.crc32(raw)).toBe(buffer.readUInt32LE(at + 16));
    out[name] = raw.toString("utf8");
    at += 46 + nameLen;
  }
  return out;
}

describe("diagnostics bundle", () => {
  const logsDir = mkdtempSync(path.join(tmpdir(), "ff-bundle-"));
  new RotatingLog(logsDir, "main", (t) => t).write(
    "error",
    "ipc",
    "unredacted source line for alice on ALICE-PC",
  );
  const data = {
    app: { frameforge: "1.4.0", user: "alice" },
    system: { cpu: "Ryzen", serialNumber: "S123" },
    errors: [{ message: "failed at C:\\Users\\alice\\x.txt" }],
  };
  it("lists exactly the chosen groups plus README and manifest, all redacted", () => {
    const files = buildBundle(
      {
        data,
        logsDir,
        version: "1.4.0",
        now: new Date("2026-10-15T10:00:00Z"),
      },
      ["app", "system", "errors", "logs"],
      redact,
    );
    const entries = unzip(zip(files));
    expect(Object.keys(entries).sort()).toEqual([
      "README.txt",
      "app.json",
      "errors.json",
      "logs/main.log",
      "manifest.json",
      "system.json",
    ]);
    const manifest = JSON.parse(entries["manifest.json"]!);
    expect(manifest.groups).toEqual(["app", "system", "errors", "logs"]);
    expect(manifest.files.sort()).toEqual(Object.keys(entries).sort());
    expect(entries["README.txt"]).toContain(issueUrl);
    expect(entries["README.txt"]).toContain("<USER>");
    const joined = Object.values(entries).join("\n");
    for (const leak of ["alice", "ALICE", "S123"])
      expect(joined, leak).not.toContain(leak);
    expect(JSON.parse(entries["system.json"]!).serialNumber).toBe("<SERIAL>");
  });
  it("leaves out groups that were not chosen", () => {
    const entries = unzip(
      zip(buildBundle({ data, logsDir, version: "1.4.0" }, ["app"], redact)),
    );
    expect(Object.keys(entries).sort()).toEqual([
      "README.txt",
      "app.json",
      "manifest.json",
    ]);
  });
});

describe("diagnostics IPC and paths", () => {
  const opened: string[] = [];
  let saved: Buffer | null = null;
  let answer: string | null = "out.zip";
  const logsDir = mkdtempSync(path.join(tmpdir(), "ff-svc-"));
  const host: DiagnosticsHost = {
    logsDir,
    redact,
    saveZip: async (_name, data) => {
      saved = data;
      return answer;
    },
    openLogs: async () => true,
    openIssue: async (url) => {
      opened.push(url);
      return true;
    },
  };
  const make = () => {
    const repo = new Repository(":memory:");
    repo.log("Test", "alice ran C:\\Users\\alice\\a.exe on ALICE-PC", "failed");
    const service = new AppService(repo, new MockPlatform(), {
      pickGame: async () => null,
      detectGames: async () => ({
        games: [],
        warnings: [],
        launchers: [],
        perLauncher: [],
      }),
      scanFolder: async () => null,
      setStartup: () => {},
      version: "1.4.0",
      diagnostics: host,
    });
    return service;
  };
  it("rejects bad export input", async () => {
    const service = make();
    for (const bad of [
      {},
      { groups: [] },
      { groups: ["nope"] },
      { groups: ["app"], path: "C:\\x.zip" },
      { groups: Array(11).fill("app") },
    ])
      await expect(
        service.dispatch("diagnosticsExport", bad),
      ).rejects.toThrow();
  });
  it("previews every group, then exports a redacted zip only the user's dialog receives", async () => {
    const service = make();
    const preview = (await service.dispatch("diagnosticsPreview", {})) as {
      groups: { id: string; files: unknown[] }[];
    };
    expect(preview.groups.map((g) => g.id)).toEqual([...diagnosticsGroups]);
    const result = await service.dispatch("diagnosticsExport", {
      groups: ["activity", "errors"],
    });
    expect(result).toMatchObject({ saved: true, file: "out.zip" });
    const entries = unzip(saved!);
    expect(Object.keys(entries)).toContain("activity.json");
    const joined = Object.values(entries).join("\n");
    expect(joined).toContain("<USER>");
    expect(joined).not.toMatch(/alice|ALICE/);
    answer = null;
    expect(
      await service.dispatch("diagnosticsExport", { groups: ["app"] }),
    ).toMatchObject({ saved: false, file: "", files: 0 });
    answer = "out.zip";
  });
  it("opens only the fixed issue page with version and Windows build", async () => {
    await make().dispatch("reportProblem", {});
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!);
    expect(url.origin + url.pathname).toBe(issueUrl);
    expect([...url.searchParams.keys()].sort()).toEqual([
      "body",
      "labels",
      "title",
    ]);
    expect(url.searchParams.get("body")).toContain("Frameforge version: 1.4.0");
    expect(allowedIssueUrl(opened[0]!)).toBe(true);
    expect(allowedIssueUrl("https://evil.example/?https://github.com")).toBe(
      false,
    );
    expect(allowedIssueUrl(issueUrl + "/../../x")).toBe(false);
    expect(reportUrl("1.4.0\n<x>", "10.0.1")).not.toContain("%3Cx%3E");
  });
  it("validates the zip path chosen in the dialog", () => {
    expect(validZipPath("C:\\Users\\bob\\Docs\\d.zip", "win32")).toBe(
      "C:\\Users\\bob\\Docs\\d.zip",
    );
    expect(validZipPath("C:\\a\\..\\b\\D.ZIP", "win32")).toBe("C:\\b\\D.ZIP");
    for (const bad of [
      "d.zip",
      "C:\\d.txt",
      "C:\\.zip",
      "\\\\server\\share\\d.zip",
      "\\\\?\\C:\\d.zip",
      "C:\\d.zip\0.txt",
      "C:\\dir\\",
      42,
      null,
    ])
      expect(validZipPath(bad, "win32"), String(bad)).toBeNull();
  });
});
