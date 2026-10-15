import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
const executable = process.env.FRAMEFORGE_EXECUTABLE;
// Never touch the real %APPDATA% profile: the app honours FRAMEFORGE_USER_DATA.
const userData = await mkdtemp(path.join(os.tmpdir(), "frameforge-smoke-"));
const app = await electron.launch({
  executablePath:
    executable ?? path.resolve("node_modules/electron/dist/electron.exe"),
  args: executable ? [] : ["."],
  // A packaged build ignores the override unless test mode is explicit.
  env: {
    ...process.env,
    FRAMEFORGE_USER_DATA: userData,
    FRAMEFORGE_TEST_MODE: "1",
    FRAMEFORGE_TEST_HOOKS: "1",
  },
  timeout: 30000,
});
try {
  assert.equal(
    await app.evaluate(({ app }) => app.getPath("userData")),
    userData,
  );
  const page = await app.firstWindow();
  // The CSP is strict on purpose: any violation (blocked font, script, style) is a build bug.
  const violations = [];
  page.on("console", (m) => {
    if (
      m.type() === "error" ||
      /Content Security Policy|violates/.test(m.text())
    )
      violations.push(m.text());
  });
  await page.getByText("Your setup, in focus.").waitFor();
  const info = await page.evaluate(async () => window.frameforge.bootstrap({}));
  assert.equal(info.mode, "desktop");
  assert.equal(info.hardware.source, "windows");
  assert.ok(info.hardware.cpu.length > 0);
  // The real helper's capability JSON must parse in the app: a mismatch makes every mechanism look unavailable.
  const boost = await page.evaluate(async () =>
    window.frameforge.boostStatus({}),
  );
  assert.ok(boost.capabilities.mechanisms.length >= 14);
  assert.ok(
    boost.capabilities.mechanisms.every(
      (m) => !m.detail.includes("Windows helper failed"),
    ),
    "the helper's capability reply was rejected",
  );
  assert.equal(typeof boost.timer.eligible, "boolean");
  await page.evaluate(() => {
    location.hash = "main-content";
  });
  assert.equal(
    (await page.evaluate(() => window.frameforge.bootstrap({}))).mode,
    "desktop",
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null),
    true,
  );
  const security = await app.evaluate(({ BrowserWindow }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      sandbox: p.sandbox,
    };
  });
  assert.deepEqual(security, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
  const rejected = await page.evaluate(async () => {
    try {
      await window.frameforge.preview({ ids: ["arbitrary-command"] });
      return false;
    } catch {
      return true;
    }
  });
  assert.ok(rejected);
  await page.evaluate(() => {
    location.hash = "";
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  // Visit every page, then check nothing was blocked.
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const buttons = nav.getByRole("button");
  for (let i = 0, n = await buttons.count(); i < n; i++) {
    await buttons.nth(i).click();
    await page.waitForTimeout(300);
  }
  assert.deepEqual(violations, [], "console errors / CSP violations");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/desktop-real-hardware.png",
    fullPage: true,
  });
  console.log(
    "Electron smoke passed: real Windows discovery, sandboxed preload, no renderer Node, invalid request rejected.",
  );
  // Closing the window destroys it (renderer freed) and keeps the app in the tray; the tray can bring it back.
  await page.getByRole("button", { name: "Monitor", exact: true }).click();
  await page.getByText("Live", { exact: true }).first().waitFor();
  // Keep the real published helper live beyond the renderer's stall timeout.
  const readingAt = () =>
    page.evaluate(async () => window.frameforge.monitorStart({}));
  assert.equal(await readingAt(), true);
  await page.waitForTimeout(8000);
  assert.equal(
    await page.getByText("Live", { exact: true }).first().isVisible(),
    true,
  );
  assert.equal(
    await page
      .getByText("No readings for a few seconds", { exact: true })
      .count(),
    0,
  );
  const hooks = (fn, arg) =>
    app.evaluate((_e, { fn, arg }) => globalThis.__frameforgeTest[fn](arg), {
      fn,
      arg,
    });
  // Global hotkeys: registered with Windows at start (or reported as conflicts when another app owns one), and unregistered when disabled.
  const keys = await hooks("hotkeys");
  assert.equal(keys.registered.length + keys.failed.length, 4);
  assert.equal(keys.os, true, "registered hotkeys are known to Windows");
  const toggleHotkeys = (enabled) =>
    page.evaluate(async (enabled) => {
      const { state } = await window.frameforge.bootstrap({});
      const { hotkeys } = state.settings;
      await window.frameforge.settings({
        ...state.settings,
        hotkeys: { ...hotkeys, enabled },
      });
    }, enabled);
  await toggleHotkeys(false);
  assert.deepEqual((await hooks("hotkeys")).registered, []);
  await toggleHotkeys(true);
  assert.equal(
    (await hooks("hotkeys")).registered.length + keys.failed.length,
    4,
  );
  console.log(
    "Electron smoke passed: global hotkeys register, unregister when disabled and report conflicts.",
  );
  // A remembered choice, so closing does not open the first-close question.
  await page.evaluate(async () => {
    const { state } = await window.frameforge.bootstrap({});
    await window.frameforge.settings({
      ...state.settings,
      closeAction: "tray",
    });
  });
  await hooks("closeWindow");
  await until(async () => (await hooks("windows")) === 0, "window destroyed");
  assert.equal(await hooks("tray"), true, "tray survives the closed window");
  assert.equal(
    await hooks("monitoring"),
    false,
    "counter helper stops when the window is destroyed",
  );
  await hooks("openWindow");
  await until(async () => (await hooks("windows")) === 1, "window reopened");
  console.log(
    "Electron smoke passed: close destroys the window, tray keeps running, reopen works.",
  );
} finally {
  await app.close();
  await rm(userData, { recursive: true, force: true });
}

// Background mode: --hidden starts with no window, and auto-boost works live on a dummy "game".
const backgroundData = await mkdtemp(path.join(os.tmpdir(), "frameforge-bg-"));
const hidden = await electron.launch({
  executablePath:
    executable ?? path.resolve("node_modules/electron/dist/electron.exe"),
  args: executable ? ["--hidden"] : [".", "--hidden"],
  env: {
    ...process.env,
    FRAMEFORGE_USER_DATA: backgroundData,
    FRAMEFORGE_TEST_MODE: "1",
    FRAMEFORGE_TEST_HOOKS: "1",
  },
  timeout: 30000,
});
// A private copy: the helper matches games by full exe path, so another Frameforge on this PC (a parallel or leaked smoke run
// whose library holds System32\PING.EXE) must not see, boost or restore this run's dummy game.
const ping = path.join(backgroundData, "frameforge-dummy-game.exe");
await copyFile(path.join(process.env.SystemRoot, "System32", "PING.EXE"), ping);
const dummies = [];
const priority = (pid) =>
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).PriorityClass`],
    { encoding: "utf8" },
  ).trim();
try {
  const call = (fn, arg) =>
    hidden.evaluate((_e, { fn, arg }) => globalThis.__frameforgeTest[fn](arg), {
      fn,
      arg,
    });
  await until(
    () => hidden.evaluate(() => !!globalThis.__frameforgeTest),
    "app ready",
  );
  assert.equal(await call("windows"), 0, "--hidden opens no window");
  assert.equal(await call("tray"), true, "tray icon exists");
  assert.equal(
    await call("watching"),
    false,
    "no watcher without library games",
  );
  const launch = () => {
    const child = spawn(ping, ["-t", "127.0.0.1"], { stdio: "ignore" });
    dummies.push(child);
    return child;
  };
  // PING.EXE stands in for a game: add it to the library; auto-boost is on, and the window is gone.
  const first = launch();
  await call("addGame", ping);
  assert.equal(await call("watching"), true, "watcher runs once a game exists");
  await until(
    async () => (await call("active")) === true,
    "auto-boost started with no window",
    30000,
  );
  await until(
    async () => (await call("session"))?.status === "active",
    "boost applied (session active)",
  );
  assert.equal(priority(first.pid), "High", "boost raised the game priority");
  assert.equal(await call("windows"), 0, "still no window while boosting");
  // Stop restores the live process.
  await call("stop");
  await until(async () => (await call("active")) === false, "boost stopped");
  assert.equal(priority(first.pid), "Normal", "stop restored the priority");
  // A new launch starts a new session; the game exiting ends it by itself.
  first.kill();
  const second = launch();
  await until(
    async () => (await call("active")) === true,
    "auto-boost started for a second launch",
    30000,
  );
  await until(
    async () => (await call("session"))?.status === "active",
    "second boost applied (session active)",
  );
  assert.equal(priority(second.pid), "High");
  second.kill();
  await until(
    async () => (await call("active")) === false,
    "boost ended when the game exited",
    30000,
  );
  console.log(
    "Electron smoke passed: --hidden has no window and a tray; auto-boost started, restored and ended live without a window.",
  );
} finally {
  for (const d of dummies) d.kill();
  await hidden.close();
  await rm(backgroundData, { recursive: true, force: true });
}
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}
