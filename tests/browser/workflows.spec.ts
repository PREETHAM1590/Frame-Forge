import { test, expect } from "@playwright/test";
test("desktop browser workflows and persistence", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Your setup, in focus.")).toBeVisible();
  await page.setViewportSize({ width: 1360, height: 960 });
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Optimizations", exact: true })
    .click();
  await page.getByLabel("Search optimizations").fill("Consistent pointer");
  await expect(
    page.getByRole("heading", { name: "Consistent pointer movement" }),
  ).toBeVisible();
  await expect(page.locator(".optimization")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Details for Consistent pointer movement" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview changes" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByLabel("Search optimizations").fill("GPU");
  await page
    .getByRole("button", { name: "Details for GPU scheduling review" })
    .click();
  await expect(
    page.getByRole("button", { name: "Open Graphics settings in Windows" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Presets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Beginner" })).toBeVisible();
  await page.getByRole("button", { name: "Custom preset" }).click();
  await page.getByLabel("Preset name").fill("My input preset");
  await page
    .getByRole("checkbox", { name: /Consistent pointer movement/ })
    .check();
  await page.getByRole("button", { name: "Save preset" }).click();
  await expect(
    page.getByRole("heading", { name: "My input preset" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit My input preset" }).click();
  await page.getByLabel("Preset name").fill("my INPUT preset renamed");
  await page.getByRole("button", { name: "Save preset" }).click();
  await expect(
    page.getByRole("heading", { name: "my INPUT preset renamed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "My input preset", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Restore & backups", exact: true })
    .click();
  await page.getByRole("button", { name: "Create backup" }).click();
  await page.getByLabel("Backup name").fill("Before theme");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create backup" })
    .click();
  await expect(page.getByText("Before theme", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Appearance").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page
    .getByRole("button", { name: "Restore & backups", exact: true })
    .click();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  for (const name of [
    "Game library",
    "Game Mode",
    "System",
    "Activity",
    "Settings",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
test("mobile navigation and dialogs have no page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("Your setup, in focus.")).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (const name of [
    "Optimizations",
    "Presets",
    "Game library",
    "Game Mode",
    "Restore & backups",
    "System",
    "Activity",
    "Settings",
  ]) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
