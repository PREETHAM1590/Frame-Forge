// Dev helper: real-data Games page and the Optimizations apply dialog, in the built app (temp profile, test mode).
// Usage: node tools/ui-flow-shots.mjs <outDir>
import { _electron as electron } from "@playwright/test";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";

const out = path.resolve(process.argv[2] ?? "ui-flow-shots");
await mkdir(out, { recursive: true });
const userData = await mkdtemp(path.join(out, "profile-"));
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["."],
  env: {
    ...process.env,
    FRAMEFORGE_USER_DATA: userData,
    FRAMEFORGE_TEST_MODE: "1",
  },
  timeout: 30000,
});
const shot = (page, name) =>
  page.screenshot({ path: path.join(out, `${name}.png`) });
try {
  const page = await app.firstWindow();
  await page.getByText("Your setup, in focus.").waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900);
  });
  await page.getByRole("button", { name: "Game library", exact: true }).click();
  await page.waitForTimeout(1500);
  // The startup auto-scan reports "(n/12)" while it runs.
  await page.waitForFunction(
    () => !/\(\d+\/\d+\)/.test(document.querySelector("main")?.innerText ?? ""),
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(800);
  await shot(page, "games-grid");
  const gameCount = await page.locator(".game-tile").count();
  console.log("tiles:", gameCount);
  await page
    .getByRole("button", { name: /Game details/i })
    .first()
    .click();
  await page.waitForTimeout(500);
  await shot(page, "games-drawer");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Remove ROBLOX" }).click();
  await page.waitForTimeout(400);
  await shot(page, "games-remove-confirm");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove game" })
    .click();
  await page.waitForTimeout(600);
  await page.getByText(/Removed games \(/).click();
  await page.waitForTimeout(500);
  await shot(page, "games-removed");
  await page.getByRole("button", { name: "Restore Roblox" }).first().click();
  await page.waitForTimeout(800);
  await shot(page, "games-restored");
  console.log("tiles after restore:", await page.locator(".game-tile").count());

  await page
    .getByRole("button", { name: "Optimizations", exact: true })
    .click();
  await page.waitForTimeout(1000);
  await page
    .getByRole("button", { name: "Details for Turn off transparency effects" })
    .click();
  await page.waitForTimeout(500);
  await shot(page, "optimizations-drawer");
  await page
    .getByRole("button", { name: /^Review|Preview/ })
    .first()
    .click();
  await page
    .getByText(/change/i)
    .first()
    .waitFor();
  await page.waitForTimeout(800);
  await shot(page, "apply-review");
  await page.getByRole("checkbox").last().check();
  await page.waitForTimeout(300);
  await shot(page, "apply-confirmed");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
} finally {
  await app.close();
}
