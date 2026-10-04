import { expect } from "@playwright/test";
import { gotoSettled } from "../helpers/navigate";
import { editorTest } from "../helpers/fixtures";
import { BASE_NAMES } from "../constants/base-resources";

editorTest.describe("Trace Management", () => {
  editorTest.beforeEach(async ({ page }) => {
    await gotoSettled(page, "/trace", page.getByRole("heading", { name: "Traces", exact: true }), {
      accessPath: "/trace",
    });
  });

  editorTest("should display the traces list and seeded base trace", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Traces", exact: true })).toBeVisible();

    // Verify seeded base trace row appears in table with task and thread ID snippet
    const traceLink = page.getByRole("link", { name: BASE_NAMES.traceTask });
    await expect(traceLink).toBeVisible();

    const shortId = `…${BASE_NAMES.traceThreadId.slice(-8)}`;
    await expect(page.getByRole("link", { name: shortId })).toBeVisible();
  });

  editorTest(
    "should navigate to trace detail and verify summary cards and run tree",
    async ({ page }) => {
      // Navigate to trace detail by clicking task link
      await page.getByRole("link", { name: BASE_NAMES.traceTask }).click();
      await page.waitForURL(new RegExp(`/trace/${BASE_NAMES.traceThreadId}`));

      // Verify header components
      await expect(
        page.getByRole("heading", { name: `Trace ${BASE_NAMES.traceThreadId}` }),
      ).toBeVisible();
      await expect(page.getByLabel("Back to traces")).toBeVisible();
      await expect(page.getByText("failed", { exact: true })).toBeVisible();

      // Verify 6 summary stat cards
      const summarySection = page.locator("section").filter({ hasText: "Tool failures" });
      await expect(summarySection).toBeVisible();
      await expect(summarySection.getByText("Runs", { exact: true })).toBeVisible();
      await expect(summarySection.getByText("Sub-runs", { exact: true })).toBeVisible();
      await expect(summarySection.getByText("Tool failures", { exact: true })).toBeVisible();
      await expect(summarySection.getByText("1/2", { exact: true })).toBeVisible();
      await expect(summarySection.getByText("Avg TTFT", { exact: true })).toBeVisible();
      await expect(summarySection.getByText("500ms")).toBeVisible();
      await expect(summarySection.getByText("Duration", { exact: true })).toBeVisible();
      await expect(summarySection.getByText("5.0s").first()).toBeVisible();

      // Verify Run tree in left timeline: top-level run (#1) and sub-run (#1.a)
      const topRun = page
        .getByRole("button")
        .filter({ hasText: "#1" })
        .filter({ hasText: BASE_NAMES.traceTask });
      await expect(topRun).toBeVisible();
      await expect(topRun.getByText("delegate_to_agent")).toBeVisible();

      const subRun = page
        .getByRole("button")
        .filter({ hasText: "#1.a" })
        .filter({ hasText: "Database connection failed" });
      await expect(subRun).toBeVisible();
      await expect(subRun.getByText("sql_query")).toBeVisible();
    },
  );

  editorTest("should inspect run details and events when switching runs", async ({ page }) => {
    await gotoSettled(
      page,
      `/trace/${BASE_NAMES.traceThreadId}`,
      page.getByRole("heading", { name: `Trace ${BASE_NAMES.traceThreadId}` }),
    );

    // Click top-level run card (#1) to view its details
    const topRun = page
      .getByRole("button")
      .filter({ hasText: "#1" })
      .filter({ hasText: BASE_NAMES.traceTask });
    await topRun.click();

    await expect(page).toHaveURL(/run=0192a000-0000-7000-8000-000000000002/);
    await expect(page.getByRole("heading", { name: /events \(5\)/i })).toBeVisible();
    await expect(page.getByText("0192a000-0000-7000-8000-000000000002")).toBeVisible();

    // Expand Input Task collapsible
    const inputToggle = page.getByRole("button", { name: /input task/i });
    await expect(inputToggle).toBeVisible();
    await inputToggle.click();
    await expect(
      page.locator("div.whitespace-pre-wrap").filter({ hasText: BASE_NAMES.traceTask }),
    ).toBeVisible();

    // Click sub-run card (#1.a) to switch right pane to sub-run details
    const subRun = page
      .getByRole("button")
      .filter({ hasText: "#1.a" })
      .filter({ hasText: "Database connection failed" });
    await subRun.click();

    await expect(page).toHaveURL(/run=0192a000-0000-7000-8000-000000000003/);
    await expect(page.getByRole("heading", { name: /events \(3\)/i })).toBeVisible();
    await expect(page.getByText("0192a000-0000-7000-8000-000000000003")).toBeVisible();
    await expect(page.getByText("Connection refused: 5432")).toBeVisible();
  });

  editorTest("should navigate back to traces list via back button", async ({ page }) => {
    await gotoSettled(
      page,
      `/trace/${BASE_NAMES.traceThreadId}`,
      page.getByRole("heading", { name: `Trace ${BASE_NAMES.traceThreadId}` }),
    );

    await page.getByLabel("Back to traces").click();
    await page.waitForURL(/\/trace$/);
    await expect(page.getByRole("heading", { name: "Traces", exact: true })).toBeVisible();
  });
});
