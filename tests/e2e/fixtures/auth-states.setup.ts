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

config();

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

  // Wait for either redirect (success) or error (user exists)
  const redirected = await Promise.race([
    page
      .waitForURL((url) => !url.pathname.includes("/sign-up"), { timeout: 8000 })
      .then(() => true),
    page
      .waitForTimeout(4000)
      .then(() => false),
  ]);

  if (!redirected) {
    // User might already exist — try sign-in
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: /sign in/i }).click();

    await page.waitForURL(
      (url) => !url.pathname.includes("/sign-in") && !url.pathname.includes("/sign-up"),
      { timeout: 10000 },
    );
  }

  // Verify we're authenticated
  const url = page.url();
  expect(url).not.toContain("/sign-in");
  expect(url).not.toContain("/sign-up");

  // Save storage state
  await page.context().storageState({ path: statePath });
}

setup("create admin user", async ({ page }) => {
  // Sign up
  await signUpOrSignIn(page, TEST_USERS.admin, ADMIN_STATE_PATH);
  // Force promote via DB
  await forceUserRole(TEST_USERS.admin.email, "admin");
  // Log out and log back in to get a clean session cookie with the new role
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(TEST_USERS.admin.email);
  await page.getByLabel("Password").fill(TEST_USERS.admin.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/sign-in") && !url.pathname.includes("/sign-up"), { timeout: 10000 });
  await page.context().storageState({ path: ADMIN_STATE_PATH });
});

setup("create editor user", async ({ page, context }) => {
  // Sign up
  await signUpOrSignIn(page, TEST_USERS.editor, EDITOR_STATE_PATH);
  // Force promote via DB
  await forceUserRole(TEST_USERS.editor.email, "editor");
  // Log out and log back in to get a clean session cookie with the new role
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(TEST_USERS.editor.email);
  await page.getByLabel("Password").fill(TEST_USERS.editor.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/sign-in") && !url.pathname.includes("/sign-up"), { timeout: 10000 });
  await context.storageState({ path: EDITOR_STATE_PATH });
});

setup("create regular user", async ({ page }) => {
  await signUpOrSignIn(page, TEST_USERS.regular, USER_STATE_PATH);
});
