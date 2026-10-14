import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
} finally {
  await app.close();
  await rm(userData, { recursive: true, force: true });
}
