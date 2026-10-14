// Screenshot of the Startup apps page from the real desktop build (read-only: nothing is switched).
import { _electron as electron } from "@playwright/test";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
const userData = await mkdtemp(path.join(os.tmpdir(), "frameforge-shot-"));
const out = process.argv[2] ?? "docs/screenshots/startup.png";
await mkdir(path.dirname(out), { recursive: true });
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, FRAMEFORGE_USER_DATA: userData, FRAMEFORGE_TEST_MODE: "1" },
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.getByText("Your setup, in focus.").waitFor();
  await page.getByRole("button", { name: /Startup apps/ }).first().click();
  await page.getByRole("list", { name: "Startup apps" }).waitFor();
  await page.screenshot({ path: out });
  console.log("saved", out);
} finally {
  await app.close();
}
