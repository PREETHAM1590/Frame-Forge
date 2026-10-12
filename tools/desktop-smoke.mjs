import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
const executable = process.env.FRAMEFORGE_EXECUTABLE;
const app = await electron.launch({
  executablePath:
    executable ?? path.resolve("node_modules/electron/dist/electron.exe"),
  args: executable ? [] : ["."],
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  await page.getByText("Your setup, in focus.").waitFor();
  const info = await page.evaluate(async () => window.frameforge.bootstrap({}));
  assert.equal(info.mode, "desktop");
  assert.equal(info.hardware.source, "windows");
  assert.ok(info.hardware.cpu.length > 0);
  await page.evaluate(() => {
    location.hash = "main-content";
  });
  assert.equal(
    (await page.evaluate(() => window.frameforge.bootstrap({}))).mode,
    "desktop",
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
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
}
