// Dev helper: screenshots every apply-flow state (review, security, progress, each result) in a browser with a mocked
// backend, so nothing touches Windows. Needs the dev server: npm run dev. Usage: node tools/ui-apply-states.mjs <outDir>
import { chromium } from "@playwright/test";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const out = path.resolve(process.argv[2] ?? "ui-apply-states");
await mkdir(out, { recursive: true });
const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";
const mock = ({ outcome, missing }) => {
  const hardware = {
    source: "windows",
    collectedAt: "2026-01-01T00:00:00.000Z",
    cpu: "CPU",
    gpu: [],
    memoryBytes: 1,
    freeMemoryBytes: 1,
    cores: 1,
    os: "Windows",
    drives: [],
    displays: [],
    drivers: [],
    warnings: [],
  };
  const row = (status, message, ids) => ({
    id: crypto.randomUUID(),
    label: "Optimization applied",
    at: new Date().toISOString(),
    status,
    message,
    ids,
    rollback: status === "success",
  });
  const results = {
    applied: [
      "success",
      "Windows settings re-read and verified. Takes effect without a restart.",
    ],
    reverted: [
      "failed",
      "Windows reverted or did not keep the change when it was read back, so nothing was reported as applied. The captured Windows state was restored.",
    ],
    failed: [
      "failed",
      "The operation did not complete (access denied). The captured Windows state was restored.",
    ],
    recovery: [
      "recovery-needed",
      "The operation did not complete and automatic recovery failed. Inspect the saved snapshot and retry rollback.",
    ],
  };
  window.frameforge = {
    bootstrap: async () => {
      const { catalogue } = await import("/shared/catalogue.ts");
      const { defaultState } = await import("/shared/contracts.ts");
      return {
        state: defaultState,
        hardware,
        activity: [],
        backups: [],
        capabilities: catalogue.map((o) => o.id).filter((id) => id !== missing),
        bootedAt: "2026-10-14T00:00:00.000Z",
        startupSupported: false,
        version: "1.0.1",
        mode: "desktop",
        boost: { session: null, available: true, watching: false },
      };
    },
    onEvent: () => () => undefined,
    restoreStatus: async () => ({
      protection: "enabled",
      policyDisabled: false,
    }),
    preview: async ({ ids }) => ({
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      ids,
      changes: ids.map((id) => ({
        id,
        setting: "HKCU/Software/Frameforge/" + id,
        before: "1 (DWORD)",
        after: "0 (DWORD)",
      })),
      warnings: [],
      restart: "none",
      admin: false,
      security: ids.filter((id) => id === "uac-off"),
    }),
    createRestorePoint: async () => ({
      outcome: "created",
      message: "created",
    }),
    confirm: async () => {
      await new Promise((r) => setTimeout(r, window.__delay ?? 0));
      const [status, message] = results[outcome] ?? results.applied;
      return row(status, message, ["transparency-off"]);
    },
    cancel: async () => ({}),
  };
};
const browser = await chromium.launch();
const open = async (outcome, missing) => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.addInitScript(mock, { outcome, missing });
  await page.goto(base);
  await page.getByText("Your setup, in focus.").waitFor();
  return page;
};
const shot = (page, name) =>
  page.screenshot({ path: path.join(out, `${name}.png`) });
const openFirst = async (page, name = "Turn off transparency effects") => {
  await page
    .getByRole("button", { name: "Optimizations", exact: true })
    .click();
  await page.getByRole("button", { name: `Details for ${name}` }).click();
  await page
    .getByRole("button", { name: /^Review|Preview/ })
    .first()
    .click();
  await page.getByText(/\d+ changes?/).waitFor();
};
const dialog = (page) => page.getByRole("dialog");
const confirm = async (page) => {
  await dialog(page).getByRole("checkbox").last().check();
  await dialog(page).getByRole("button", { name: "Confirm & apply" }).click();
};
try {
  // applied (+ progress shot while the confirm is delayed)
  let page = await open("applied");
  await page.evaluate(() => (window.__delay = 4000));
  await openFirst(page);
  await shot(page, "apply-1-review");
  await dialog(page).getByRole("checkbox").first().uncheck();
  await confirm(page);
  await page.getByRole("status").filter({ hasText: "Applying" }).waitFor();
  await page.waitForTimeout(500);
  await shot(page, "apply-2-progress");
  await dialog(page)
    .getByRole("heading", { name: "Applied" })
    .waitFor({ timeout: 10000 });
  console.log(
    "focused after result:",
    await page.evaluate(() => document.activeElement?.textContent),
  );
  await shot(page, "apply-3-applied");
  await page.close();
  for (const outcome of ["reverted", "failed", "recovery"]) {
    page = await open(outcome);
    await openFirst(page);
    await confirm(page);
    await dialog(page).getByRole("heading", { level: 3 }).first().waitFor();
    await page.waitForTimeout(300);
    await shot(page, `apply-4-${outcome}`);
    await page.close();
  }
  // security trade-off
  page = await open("applied");
  await openFirst(page, "Turn off User Account Control");
  await dialog(page).getByRole("checkbox").last().check();
  await shot(page, "apply-5-security");
  await page.close();
  // partially applied: a preset with one item whose prerequisite is missing
  page = await open("applied", "power-plan");
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await page
    .locator("article")
    .filter({ hasText: "Recommended" })
    .getByRole("button", { name: /Review preset/ })
    .click();
  await dialog(page)
    .getByText(/\d+ changes?/)
    .waitFor();
  await shot(page, "apply-6-preset-skipped");
  await confirm(page);
  await dialog(page).getByRole("heading", { level: 3 }).first().waitFor();
  await page.waitForTimeout(300);
  await shot(page, "apply-7-partial");
  await page.close();
} finally {
  await browser.close();
}
console.log("saved to", out);
