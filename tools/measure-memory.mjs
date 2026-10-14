// Memory/CPU of every Frameforge process in three states: window open, tray idle (window destroyed), tray with a boost active.
// Usage: node tools/measure-memory.mjs window|tray|boost   (isolated profile; needs the build and the helper)
import { _electron as electron } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
const scenario = process.argv[2] ?? "window";
const userData = await mkdtemp(path.join(os.tmpdir(), "frameforge-mem-"));
const ps = (script) =>
  spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).stdout;
const sample = (root) => {
  const out = ps(`
    $all = Get-CimInstance Win32_Process
    $ids = @(${root}); $grow = $true
    while ($grow) { $grow = $false; foreach ($p in $all) { if (($ids -contains $p.ParentProcessId) -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $grow = $true } } }
    $pw = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | % { $pw[[int]$_.IDProcess] = $_.WorkingSetPrivate }
    Get-Process -Id $ids -ErrorAction SilentlyContinue | % { "$($_.Id)|$($_.ProcessName)|$([math]::Round($_.WorkingSet64/1MB,1))|$([math]::Round($pw[$_.Id]/1MB,1))|$([math]::Round($_.CPU,2))" }`);
  return out
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [pid, name, ws, priv, cpu] = l.split("|");
      return { pid, name, ws: +ws, priv: +priv, cpu: +cpu };
    });
};
const app = await electron.launch({
  args: [
    ".",
    ...(scenario === "window" ? [] : ["--hidden"]),
    ...(process.env.MEASURE_ARGS?.split(" ").filter(Boolean) ?? []),
  ],
  env: {
    ...process.env,
    FRAMEFORGE_USER_DATA: userData,
    FRAMEFORGE_TEST_MODE: "1",
  },
  timeout: 30000,
});
let dummy;
try {
  const pid = await app.evaluate(() => process.pid);
  if (scenario === "window") await app.firstWindow();
  if (scenario === "boost") {
    const exe = path.join(process.env.SystemRoot, "System32", "PING.EXE");
    dummy = spawn(exe, ["-t", "127.0.0.1"], { stdio: "ignore" });
    while (!(await app.evaluate(() => !!globalThis.__frameforgeTest)))
      await new Promise((r) => setTimeout(r, 300));
    await app.evaluate(
      async (_e, { exe }) => globalThis.__frameforgeTest.addGame(exe),
      { exe },
    );
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await app.evaluate(() => globalThis.__frameforgeTest.active())) break;
    }
  }
  await new Promise((r) => setTimeout(r, 25000));
  const a = sample(pid);
  await new Promise((r) => setTimeout(r, 10000));
  const b = sample(pid);
  const cpu = b.reduce((s, p) => {
    const before = a.find((x) => x.pid === p.pid);
    return s + (before ? p.cpu - before.cpu : 0);
  }, 0);
  console.table(
    b.map(({ pid, cpu: total, ...r }) => ({
      ...r,
      cpuSecIn10s: +(
        total - (a.find((x) => x.pid === pid)?.cpu ?? total)
      ).toFixed(2),
    })),
  );
  console.log(
    JSON.stringify({
      scenario,
      processes: b.length,
      workingSetMB: +b.reduce((s, p) => s + p.ws, 0).toFixed(1),
      privateWorkingSetMB: +b.reduce((s, p) => s + p.priv, 0).toFixed(1),
      cpuPercentOfOneCore: +((cpu / 10) * 100).toFixed(2),
    }),
  );
} finally {
  dummy?.kill();
  await app.close().catch(() => null);
  await rm(userData, { recursive: true, force: true });
}
