/**
 * Playwright setup: register test users via the sign-up API and save
 * authenticated browser state (cookies) for subsequent tests.
 *
 * This runs as a Playwright "setup" project before any spec files.
 * Order matters: admin must be the first user created so it receives
 * the admin role automatically. The editor user is promoted via the
 * admin API after creation.
 */

import { test as setup, expect } from "@playwright/test";
import { config } from "dotenv";
import pg from "pg";
import { getPostgresUrl } from "@/lib/db/postgres-url";
import { TEST_USERS } from "../constants/test-users";
import {
  seedBaseResources,
  seedBaseSchedule,
  seedBaseNotifications,
  seedBaseMcpServer,
  seedBaseDataSource,
  seedBaseSshServer,
  seedBaseVerificationSuite,
  seedBaseEvalSuite,
  seedBaseWebAutoSuite,
  seedBaseTrace,
  seedRealNoAuthMcpServers,
} from "./base-seed";

config();

// Enforce serial execution to prevent multi-worker races on DB state and role promotion
setup.describe.configure({ mode: "serial" });

const { Client } = pg;

async function forceUserRole(email: string, role: string) {
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();
    await client.query(
      `UPDATE "user" SET role = $1 WHERE email = $2`,
      [role, email],
    );
    console.log(`  [E2E Setup] Forced user role for ${email} to ${role}.`);
  } catch (err) {
    console.error(`  [E2E Setup] Failed to force user role for ${email}:`, err);
  } finally {
    await client.end();
  }
}

const ADMIN_STATE_PATH = "tests/e2e/.auth/admin.json";
const EDITOR_STATE_PATH = "tests/e2e/.auth/editor.json";
const USER_STATE_PATH = "tests/e2e/.auth/user.json";

/**
 * Sign up a user via the UI and save the authenticated storage state.
 * If sign-up fails (user already exists), sign in instead.
 */
async function signUpOrSignIn(
  page: import("@playwright/test").Page,
  user: { name: string; email: string; password: string },
  statePath: string,
) {
  // Try sign-up first
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: /sign up/i }).click();

  // Wait for either redirect (success) or error indicator on the form
  const outcome = await Promise.race([
    page
      .waitForURL((url) => !url.pathname.includes("/sign-up"), { timeout: 15000 })
      .then(() => "success" as const),
    page
      .locator("p.text-destructive")
      .waitFor({ state: "visible", timeout: 15000 })
      .then(() => "error" as const),
  ]).catch(() => "timeout" as const);

  if (outcome !== "success") {
    // User might already exist — try sign-in
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: /sign in/i }).click();

    await page.waitForURL(
      (url) => !url.pathname.includes("/sign-in") && !url.pathname.includes("/sign-up"),
      { timeout: 15000 },
    );
  }

  // Verify we're authenticated
  const url = page.url();
  expect(url).not.toContain("/sign-in");
  expect(url).not.toContain("/sign-up");

  // Save storage state
  await page.context().storageState({ path: statePath });
}

/**
 * Mint a fresh session cookie reflecting a just-promoted role using an isolated
 * BrowserContext. Avoids in-flight request races (SSE/SWR) and stale cookie resurrection.
 */
async function reAuthenticateInFreshContext(
  browser: import("@playwright/test").Browser,
  user: { email: string; password: string },
  statePath: string,
  targetContext?: import("@playwright/test").BrowserContext,
): Promise<void> {
  const freshContext = await browser.newContext();
  const page = await freshContext.newPage();
  try {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(
      (url) =>
        !url.pathname.includes("/sign-in") && !url.pathname.includes("/sign-up"),
      { timeout: 15000 },
    );
    const state = await freshContext.storageState({ path: statePath });
    if (targetContext) {
      await targetContext.clearCookies();
      await targetContext.addCookies(state.cookies);
    }
  } finally {
    await freshContext.close();
  }
}

setup("create admin user", async ({ page, browser, playwright }) => {
  // Sign up
  await signUpOrSignIn(page, TEST_USERS.admin, ADMIN_STATE_PATH);
  // Force promote via DB
  await forceUserRole(TEST_USERS.admin.email, "admin");
  // Re-authenticate in an isolated context to ensure updated role in cookieCache
  await reAuthenticateInFreshContext(browser, TEST_USERS.admin, ADMIN_STATE_PATH, page.context());

  // ── Seed Base Resources (Layer 0, Layer 1, MCP, Data Source, SSH, Verification) ─────
  const adminRequest = await playwright.request.newContext({
    storageState: ADMIN_STATE_PATH,
  });
  try {
    await seedBaseResources(adminRequest);
  } finally {
    await adminRequest.dispose();
  }
  await seedBaseMcpServer(TEST_USERS.admin.email);
  await seedRealNoAuthMcpServers(TEST_USERS.admin.email);
  await seedBaseDataSource(TEST_USERS.admin.email);
  await seedBaseSshServer(TEST_USERS.admin.email);
  await seedBaseVerificationSuite(TEST_USERS.admin.email);
  await seedBaseEvalSuite(TEST_USERS.admin.email);
  await seedBaseWebAutoSuite(TEST_USERS.admin.email);
});

setup("create editor user", async ({ page, browser }) => {
  // Sign up
  await signUpOrSignIn(page, TEST_USERS.editor, EDITOR_STATE_PATH);
  // Force promote via DB
  await forceUserRole(TEST_USERS.editor.email, "editor");
  // Re-authenticate in an isolated context to ensure updated role in cookieCache
  await reAuthenticateInFreshContext(browser, TEST_USERS.editor, EDITOR_STATE_PATH, page.context());
  await seedBaseTrace(TEST_USERS.editor.email);
});

setup("create regular user", async ({ page }) => {
  await signUpOrSignIn(page, TEST_USERS.regular, USER_STATE_PATH);
  await seedBaseSchedule(page.request);
  await seedBaseNotifications(TEST_USERS.regular.email);
});

setup("create dedicated sign-in test user", async ({ page }) => {
  // Sign up a standalone user for signin.spec so sign-in tests do not compete with admin/editor sessions
  await signUpOrSignIn(page, TEST_USERS.signinTestUser, "tests/e2e/.auth/signin-test.json");
});
