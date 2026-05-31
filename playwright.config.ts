import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

// Load .env for local runs; CI provides its own env vars.
config();

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : 2,
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: "playwright-report" }],
        ["list"],
      ]
    : [["html"], ["list"]],
  use: {
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:9300",
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },

  globalTeardown: "./tests/e2e/lifecycle/teardown.global.ts",

  projects: [
    // Setup: seed test users and save auth state
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
    },
    // Main tests: depend on setup for auth state
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testMatch: /.*\.spec\.ts/,
      testIgnore: [/.*\.setup\.ts/],
    },
  ],

  webServer: {
    command: "pnpm start",
    url: "http://localhost:9300",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
