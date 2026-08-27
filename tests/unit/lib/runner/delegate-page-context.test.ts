import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  formatPageContextSnapshot,
  type PageContextSnapshot,
} from "@/lib/runner/extract-run-input";
import { delegateToAgentArgsSchema } from "@/components/right-panels/DelegateToAgentCard";

describe("delegate_to_agent parameter validation", () => {
  it("validates valid arguments without includePageContext", () => {
    const parsed = delegateToAgentArgsSchema.parse({
      agent: "Built-in / Developer",
      task: "Optimize this SQL query",
    });
    expect(parsed.agent).toBe("Built-in / Developer");
    expect(parsed.task).toBe("Optimize this SQL query");
    expect(parsed.includePageContext).toBeUndefined();
  });

  it("validates valid arguments with includePageContext: true", () => {
    const parsed = delegateToAgentArgsSchema.parse({
      agent: "Built-in / Developer",
      task: "Optimize this SQL query",
      includePageContext: true,
    });
    expect(parsed.includePageContext).toBe(true);
  });

  it("validates valid arguments with includePageContext: false", () => {
    const parsed = delegateToAgentArgsSchema.parse({
      agent: "Built-in / Developer",
      task: "Optimize this SQL query",
      includePageContext: false,
    });
    expect(parsed.includePageContext).toBe(false);
  });
});

describe("formatPageContextSnapshot", () => {
  it("formats complete page context snapshot", () => {
    const snapshot: PageContextSnapshot = {
      activeUrl: "/agent/550e8400-e29b-41d4-a716-446655440000",
      activeView: "agent-editor",
      activeResourceId: "550e8400-e29b-41d4-a716-446655440000",
      activeResourceData: {
        name: "Dev Agent",
        model: "claude-3-5-sonnet",
        prompt: "You are an expert coder.",
      },
    };

    const formatted = formatPageContextSnapshot(snapshot);
    expect(formatted).toContain("- **Active View / Panel**: `agent-editor`");
    expect(formatted).toContain("- **Active Resource ID**: `550e8400-e29b-41d4-a716-446655440000`");
    expect(formatted).toContain("- **Active URL**: `/agent/550e8400-e29b-41d4-a716-446655440000`");
    expect(formatted).toContain('"name": "Dev Agent"');
    expect(formatted).toContain('"model": "claude-3-5-sonnet"');
    expect(formatted).toContain('"prompt": "You are an expert coder."');
  });

  it("handles null activeResourceData", () => {
    const snapshot: PageContextSnapshot = {
      activeUrl: "/dashboard",
      activeView: "dashboard",
      activeResourceId: null,
      activeResourceData: null,
    };

    const formatted = formatPageContextSnapshot(snapshot);
    expect(formatted).toContain("- **Active View / Panel**: `dashboard`");
    expect(formatted).toContain("- **Active URL**: `/dashboard`");
    expect(formatted).not.toContain("Active Resource Content");
  });

  it("handles empty object gracefully", () => {
    const formatted = formatPageContextSnapshot({});
    expect(formatted).toBe("(No active resource open in editor)");
  });
});

describe("delegation failure detection and handling", () => {
  it("detects failure when delegate_to_agent returns isError: true", async () => {
    const { detectToolResultStatus, extractErrorMessage } = await import(
      "@/lib/copilot/detect-tool-result-status"
    );

    const failureResult = JSON.stringify({
      isError: true,
      message: "This model is unavailable for free. The paid version is available now.",
      runId: "018f-1234",
      status: "failed",
    });

    expect(detectToolResultStatus(failureResult)).toBe("failure");
    expect(extractErrorMessage(failureResult)).toBe(
      "This model is unavailable for free. The paid version is available now.",
    );
  });

  it("detects success when delegate_to_agent succeeds", async () => {
    const { detectToolResultStatus } = await import(
      "@/lib/copilot/detect-tool-result-status"
    );

    const successResult = JSON.stringify({
      ok: true,
      runId: "018f-1234",
      status: "succeeded",
      summary: "Analysis complete: all tests pass.",
    });

    expect(detectToolResultStatus(successResult)).toBe("success");
  });
});
