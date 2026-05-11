import { defineConfig, devices } from "@playwright/test";

// E2E is opt-in: tests sit in `tests/e2e/` and the suite is run with
// `npx playwright test`. CI does not invoke this by default — the Vitest
// suite (`npm test`) is what each PR has to pass.
//
// To run locally:
//   1. `npx playwright install chromium` (one-time, downloads the browser)
//   2. `npm run dev` in one shell
//   3. `npx playwright test` in another
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
