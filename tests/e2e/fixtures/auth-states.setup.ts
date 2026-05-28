/**
 * Playwright setup: register test users via the sign-up API and save
 * authenticated browser state (cookies) for subsequent tests.
 *
 * This runs as a Playwright "setup" project before any spec files.
 */

import { test as setup, expect } from "@playwright/test";
import { TEST_USERS } from "../constants/test-users";

const ADMIN_STATE_PATH = "tests/e2e/.auth/admin.json";
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
  // Admin must be the FIRST user created (gets admin role automatically)
  await signUpOrSignIn(page, TEST_USERS.admin, ADMIN_STATE_PATH);
});

setup("create regular user", async ({ page }) => {
  await signUpOrSignIn(page, TEST_USERS.regular, USER_STATE_PATH);
});
