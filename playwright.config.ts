import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 30000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5173",
    headless: true,
  },
  // `npm run test:e2e` starts the dev server itself (and reuses one that is already running).
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 60000,
  },
  workers: 1,
  reporter: "list",
});
