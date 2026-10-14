// Memory/CPU of every Frameforge process in three states: window open, tray idle (window destroyed), tray with a boost active.
// Usage: node tools/measure-memory.mjs window|monitor|tray|boost (isolated profile; needs the build and helper)
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
    ...(["window", "monitor"].includes(scenario) ? [] : ["--hidden"]),
    ...(process.env.MEASURE_ARGS?.split(" ").filter(Boolean) ?? []),
  ],
  env: {
    ...process.env,
    FRAMEFORGE_USER_DATA: userData,
    FRAMEFORGE_TEST_MODE: "1",
    FRAMEFORGE_TEST_HOOKS: "1",
  },
  timeout: 30000,
});
let dummy;
let monitorPage;
try {
  const pid = await app.evaluate(() => process.pid);
  if (["window", "monitor"].includes(scenario)) await app.firstWindow();
  if (scenario === "monitor") {
    const page = await app.firstWindow();
    monitorPage = page;
    await page.evaluate(() => {
      globalThis.__monitorReadings = 0;
      window.frameforge.onEvent((event) => {
        if (event.type === "monitor") globalThis.__monitorReadings++;
      });
    });
    await page.getByRole("button", { name: "Monitor", exact: true }).click();
    await page.getByText("Live", { exact: true }).first().waitFor();
    if (
      !(await app.evaluate(({ app }) =>
        app.commandLine.hasSwitch("disable-gpu"),
      ))
    )
      throw new Error("Monitor measurement requires --disable-gpu.");
  }
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
  await new Promise((r) =>
    setTimeout(r, scenario === "monitor" ? 65000 : 25000),
  );
  const readingsBefore = monitorPage
    ? await monitorPage.evaluate(() => globalThis.__monitorReadings)
    : 0;
  const started = performance.now();
  const a = sample(pid);
  const firstAt = performance.now();
  await new Promise((r) =>
    setTimeout(r, scenario === "monitor" ? 30000 : 10000),
  );
  const secondStarted = performance.now();
  const b = sample(pid);
  const secondAt = performance.now();
  // Account for the sampling command itself; midpoint timestamps bound its collection latency.
  const elapsed =
    ((secondStarted + secondAt) / 2 - (started + firstAt) / 2) / 1000;
  const monitorReadings = monitorPage
    ? (await monitorPage.evaluate(() => globalThis.__monitorReadings)) -
      readingsBefore
    : undefined;
  if (
    monitorPage &&
    (monitorReadings < 20 ||
      !(await monitorPage
        .getByText("Live", { exact: true })
        .first()
        .isVisible()))
  )
    throw new Error("Monitor readings stalled during the CPU measurement.");
  const cpu = b.reduce((s, p) => {
    const before = a.find((x) => x.pid === p.pid);
    return s + (before ? p.cpu - before.cpu : 0);
  }, 0);
  console.table(
    b.map(({ pid, cpu: total, ...r }) => ({
      ...r,
      cpuSeconds: +(
        total - (a.find((x) => x.pid === pid)?.cpu ?? total)
      ).toFixed(2),
    })),
  );
  console.log(
    JSON.stringify({
      scenario,
      sampleSeconds: +elapsed.toFixed(2),
      monitorReadings,
      processes: b.length,
      workingSetMB: +b.reduce((s, p) => s + p.ws, 0).toFixed(1),
      privateWorkingSetMB: +b.reduce((s, p) => s + p.priv, 0).toFixed(1),
      cpuPercentOfOneCore: +((cpu / elapsed) * 100).toFixed(2),
    }),
  );
} finally {
  dummy?.kill();
  await app.close().catch(() => null);
  await rm(userData, { recursive: true, force: true });
}
