import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { evaluateToolRisk } from "@/lib/agent-pipeline/risk-registry";
import { toolApprovalMiddleware } from "@/lib/agent-pipeline/middlewares";
import type { MiddlewareContext } from "@/lib/agent-pipeline/types";

describe("evaluateToolRisk — Builtin tools", () => {
  it("evaluates read-only builtin tools as low risk", () => {
    const res = evaluateToolRisk("generate_echarts_config");
    expect(res.riskLevel).toBe("low");
    expect(res.sideEffects).toBe("none");
    expect(res.requiresApproval).toBe(false);
    expect(res.headlessAllowed).toBe(true);
  });

  it("evaluates web_search as low risk", () => {
    const res = evaluateToolRisk("web_search");
    expect(res.riskLevel).toBe("low");
    expect(res.sideEffects).toBe("read");
    expect(res.requiresApproval).toBe(false);
  });

  it("evaluates run_code_in_sandbox as high risk with headlessAllowed", () => {
    const res = evaluateToolRisk("run_code_in_sandbox");
    expect(res.riskLevel).toBe("high");
    expect(res.requiresApproval).toBe(true);
    expect(res.headlessAllowed).toBe(true);
  });
});

describe("evaluateToolRisk — MCP Annotations", () => {
  it("honors MCP readOnlyHint: true", () => {
    const res = evaluateToolRisk("custom_mcp_tool", {}, { readOnlyHint: true });
    expect(res.riskLevel).toBe("low");
    expect(res.sideEffects).toBe("read");
    expect(res.requiresApproval).toBe(false);
  });

  it("honors MCP destructiveHint: true", () => {
    const res = evaluateToolRisk("custom_mcp_tool", {}, { destructiveHint: true });
    expect(res.riskLevel).toBe("critical");
    expect(res.sideEffects).toBe("destructive");
    expect(res.requiresApproval).toBe(true);
    expect(res.headlessAllowed).toBe(false);
  });

  it("applies lenient default policy for unannotated MCP tools", () => {
    const res = evaluateToolRisk("unannotated_tool", {}, undefined, "lenient");
    expect(res.riskLevel).toBe("medium");
    expect(res.requiresApproval).toBe(false);
  });

  it("applies require default policy for unannotated MCP tools", () => {
    const res = evaluateToolRisk("unannotated_tool", {}, undefined, "require");
    expect(res.riskLevel).toBe("high");
    expect(res.requiresApproval).toBe(true);
    expect(res.headlessAllowed).toBe(false);
  });
});

describe("evaluateToolRisk — Dynamic assessArgs", () => {
  it("escalates SSH command with dangerous pattern (rm -rf) to critical", () => {
    const res = evaluateToolRisk("run_ssh_command", { command: "rm -rf /tmp/data" });
    expect(res.riskLevel).toBe("critical");
    expect(res.sideEffects).toBe("destructive");
    expect(res.requiresApproval).toBe(true);
    expect(res.headlessAllowed).toBe(false);
  });

  it("escalates SQL query with write pattern (DELETE FROM) to high", () => {
    const res = evaluateToolRisk("extract_dataset_by_sql", { sql_text: "DELETE FROM users WHERE id = 1" });
    expect(res.riskLevel).toBe("high");
    expect(res.sideEffects).toBe("write");
    expect(res.requiresApproval).toBe(true);
  });

  it("keeps SQL SELECT query as low risk", () => {
    const res = evaluateToolRisk("extract_dataset_by_sql", { sql_text: "SELECT * FROM users" });
    expect(res.riskLevel).toBe("low");
    expect(res.requiresApproval).toBe(false);
  });
});

describe("G20 Headless Deny in toolApprovalMiddleware", () => {
  it("blocks tools requiring manual approval when ctx.isHeadless is true", async () => {
    const mw = toolApprovalMiddleware({ approvalMode: "auto", exemptTools: new Set() });
    const ctx: MiddlewareContext = {
      isHeadless: true,
      userId: "u1",
      metadata: {},
    };

    const decision = await mw.wrapToolCall(
      ctx,
      { toolName: "run_ssh_command", args: { command: "rm -rf /" } },
      async () => "ok",
    );

    expect(decision).toEqual({
      isError: true,
      message: "Headless execution denied for tool requiring manual approval: run_ssh_command",
    });
  });

  it("allows low risk tools in headless mode", async () => {
    const mw = toolApprovalMiddleware({ approvalMode: "auto", exemptTools: new Set() });
    const ctx: MiddlewareContext = {
      isHeadless: true,
      userId: "u1",
      metadata: {},
    };

    const result = await mw.wrapToolCall(
      ctx,
      { toolName: "web_search", args: { query: "hello" } },
      async () => "search-results",
    );

    expect(result).toBe("search-results");
  });
});
