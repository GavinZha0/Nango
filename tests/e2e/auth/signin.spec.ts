import { test, expect } from "@playwright/test";
import { TEST_USERS } from "../constants/test-users";

test.describe("Sign In", () => {
  test("should sign in with valid admin credentials", async ({ page }) => {
    await page.goto("/sign-in");

    await page.getByLabel("Email").fill(TEST_USERS.admin.email);
    await page.getByLabel("Password").fill(TEST_USERS.admin.password);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Wait for redirect after successful login
    await page.waitForURL(
      (url) => !url.pathname.includes("/sign-in") && !url.pathname.includes("/sign-up"),
      { timeout: 10000 },
    );

    expect(page.url()).not.toContain("/sign-in");
    expect(page.url()).not.toContain("/sign-up");
  });

  test("should handle invalid credentials", async ({ page }) => {
    await page.goto("/sign-in");

    await page.getByLabel("Email").fill("nonexistent@test-e2e.local");
    await page.getByLabel("Password").fill("WrongPassword123!");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Should still be on sign-in page
    await page.waitForTimeout(2000);
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("should show validation on empty form", async ({ page }) => {
    await page.goto("/sign-in");

    await page.getByRole("button", { name: /sign in/i }).click();

    // Should stay on sign-in page
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("should navigate to sign-up from sign-in", async ({ page }) => {
    await page.goto("/sign-in");

    const signUpLink = page.getByRole("link", { name: /sign up/i });
    await expect(signUpLink).toBeVisible();
    await signUpLink.click();

    await page.waitForURL(/.*sign-up.*/, { timeout: 5000 });
    expect(page.url()).toContain("/sign-up");
  });

  test("should sign in with regular user credentials", async ({ page }) => {
    await page.goto("/sign-in");

    await page.getByLabel("Email").fill(TEST_USERS.regular.email);
    await page.getByLabel("Password").fill(TEST_USERS.regular.password);
    await page.getByRole("button", { name: /sign in/i }).click();

    await page.waitForURL(
      (url) => !url.pathname.includes("/sign-in") && !url.pathname.includes("/sign-up"),
      { timeout: 10000 },
    );

    expect(page.url()).not.toContain("/sign-in");
  });
});
