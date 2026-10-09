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
    viewport: { width: 1600, height: 900 },
  },

  globalSetup: "./tests/e2e/lifecycle/setup.global.ts",
  globalTeardown: "./tests/e2e/lifecycle/teardown.global.ts",

  projects: [
    // Setup: seed test users and save auth state
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
    },
    // Core tests: depend on setup for auth state, excluding external real-LLM and real-MCP tests
    {
      name: "chromium",
      dependencies: ["setup"],
      testMatch: /.*\.spec\.ts/,
      testIgnore: [
        /.*\.setup\.ts/,
        /tests[\\/]e2e[\\/]real-llm[\\/].*/,
        /tests[\\/]e2e[\\/]real-mcp[\\/].*/,
      ],
    },
    // Real LLM tests: exercises external live model providers (e.g. Groq)
    {
      name: "real-llm",
      dependencies: ["setup"],
      testMatch: /tests[\\/]e2e[\\/]real-llm[\\/].*\.spec\.ts/,
    },
    // Real MCP tests: exercises external public MCP servers (e.g. Microsoft Learn, Playground)
    {
      name: "real-mcp",
      dependencies: ["setup"],
      testMatch: /tests[\\/]e2e[\\/]real-mcp[\\/].*\.spec\.ts/,
    },
  ],

  // CI starts the server explicitly via `next start` (bypassing the
  // `prestart` hook to skip the Python-sandbox image build); see
  // .github/workflows/e2e-tests.yml "Start application". Local devs
  // usually have `pnpm dev` running. In either case playwright should
  // reuse what is already on :9300 rather than spawn a second copy.
  webServer: {
    command: "pnpm start",
    url: "http://localhost:9300",
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    // Marks a playwright-spawned server as serving an E2E run so
    // better-auth relaxes its sign-in/sign-up rate limit (see
    // src/lib/auth/auth-instance.ts) — the auth setup project alone
    // exceeds better-auth's default 3-per-10s-per-IP special rule.
    // NOTE: with reuseExistingServer this env only applies when
    // playwright itself spawns the server; an already-running dev
    // server keeps its own env, so the relaxed limit is additionally
    // gated by test-time checks (see auth specs' error assertion).
    env: { ...process.env, E2E_TEST: "1" },
  },
});
