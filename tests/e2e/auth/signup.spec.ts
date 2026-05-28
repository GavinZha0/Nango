import { test, expect } from "@playwright/test";

test.describe("Sign Up", () => {
  test("should navigate to sign-up page", async ({ page }) => {
    await page.goto("/sign-up");
    await expect(page.getByRole("heading", { name: /sign up/i })).toBeVisible();
  });

  test("should show validation on empty form", async ({ page }) => {
    await page.goto("/sign-up");
    await page.getByRole("button", { name: /sign up/i }).click();

    // Should stay on sign-up page (HTML5 validation prevents submission)
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("should navigate to sign-in from sign-up", async ({ page }) => {
    await page.goto("/sign-up");

    const signInLink = page.getByRole("link", { name: /sign in/i });
    await expect(signInLink).toBeVisible();
    await signInLink.click();

    await page.waitForURL(/.*sign-in.*/, { timeout: 5000 });
    expect(page.url()).toContain("/sign-in");
  });
});
