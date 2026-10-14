// Dev helper: launches the built app and saves Dashboard / Game Mode screenshots.
// Usage: node tools/ui-shots.mjs <outDir>
import { _electron as electron } from "@playwright/test";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";

// Usage: node tools/ui-shots.mjs <outDir> [light]
const theme = process.argv[3] === "light" ? "-light" : "";
const pages = [
  "Dashboard",
  "Game Mode",
  "Game library",
  "Optimizations",
  "Presets",
  "Restore & backups",
  "Activity",
  "System",
  "Settings",
];
const out = path.resolve(process.argv[2] ?? "ui-shots");
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
try {
  const page = await app.firstWindow();
  await page.getByText("Your setup, in focus.").waitFor();
  if (theme) {
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
  }
  for (const [w, h] of [
    [1280, 800],
    [1600, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(w, h);
      },
      [w, h],
    );
    await page.waitForTimeout(600);
    for (const name of pages) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.waitForTimeout(1000);
      await page.screenshot({
        path: path.join(
          out,
          `${name.toLowerCase().replace(/\W+/g, "-")}-${w}${theme}.png`,
        ),
        fullPage: true,
      });
    }
  }
  console.log("saved to", out);
} finally {
  await app.close();
}
