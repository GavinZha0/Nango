import { describe, expect, it } from "vitest";

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

  it("evaluates generate_bento_slides as low risk with none sideEffects", () => {
    const res = evaluateToolRisk("generate_bento_slides");
    expect(res.riskLevel).toBe("low");
    expect(res.sideEffects).toBe("none");
    expect(res.requiresApproval).toBe(false);
    expect(res.headlessAllowed).toBe(true);
  });

  it("evaluates edit_bento_slides as low risk by default", () => {
    const res = evaluateToolRisk("edit_bento_slides");
    expect(res.riskLevel).toBe("low");
    expect(res.sideEffects).toBe("write");
    expect(res.requiresApproval).toBe(false);
    expect(res.headlessAllowed).toBe(true);
  });

  it("evaluates read_file as a low-risk read", () => {
    const res = evaluateToolRisk("read_file", { path: "notes.md" });
    expect(res.riskLevel).toBe("low");
    expect(res.sideEffects).toBe("read");
    expect(res.requiresApproval).toBe(false);
    expect(res.headlessAllowed).toBe(true);
  });

  it("evaluates both knowledge tools as low-risk reads", () => {
    // CONTRACT: an unannotated tool defaults to medium / write, which would make
    // a scheduled run deny a KB read.
    for (const name of ["list_kb_pages", "read_kb_page"]) {
      const res = evaluateToolRisk(name, { kb_name: "x-manual" });
      expect(res.riskLevel).toBe("low");
      expect(res.sideEffects).toBe("read");
      expect(res.requiresApproval).toBe(false);
      expect(res.headlessAllowed).toBe(true);
    }
  });

  it("evaluates write_file as high risk and denies it headlessly", () => {
    // CONTRACT: the jail is the user's real mounted folder, so a write is
    // never sandboxed — scheduled/async runs must deny it by default.
    const res = evaluateToolRisk("write_file", { path: "notes.md", content: "x" });
    expect(res.riskLevel).toBe("high");
    expect(res.sideEffects).toBe("write");
    expect(res.requiresApproval).toBe(true);
    expect(res.headlessAllowed).toBe(false);
  });

  it("denies edit_file with the same posture as write_file", () => {
    // CONTRACT: edit_file is auto-mounted beside write_file and rewrites the
    // same real files, so it must not slip into a scheduled run through the
    // unannotated default.
    const res = evaluateToolRisk("edit_file", {
      path: "notes.md",
      old_string: "a",
      new_string: "b",
    });
    expect(res.riskLevel).toBe("high");
    expect(res.sideEffects).toBe("write");
    expect(res.requiresApproval).toBe(true);
    expect(res.headlessAllowed).toBe(false);
  });

  it("denies download_file headlessly too", () => {
    // CONTRACT: download_file puts bytes into that same real folder and
    // makes an outbound request, so it inherits write_file's posture rather
    // than falling through to the unannotated default (which would allow it
    // headless).
    const res = evaluateToolRisk("download_file", {
      url: "https://example.com/a.txt",
      target_path: "a.txt",
    });
    expect(res.riskLevel).toBe("high");
    expect(res.sideEffects).toBe("write");
    expect(res.requiresApproval).toBe(true);
    expect(res.headlessAllowed).toBe(false);
  });

  it("lets create_folder stay headless-allowed at medium risk", () => {
    // CONTRACT: mkdir is non-destructive and idempotent, so an unattended
    // run may still lay out a directory; the content-landing tools carry
    // the denials.
    const res = evaluateToolRisk("create_folder", { path: "inbox/debian" });
    expect(res.riskLevel).toBe("medium");
    expect(res.sideEffects).toBe("write");
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

  it("treats a reviewed skill SQL script as a low-risk read", () => {
    const res = evaluateToolRisk("run_skill_sql_script", {
      name: "sales-report",
      filename: "reports/sales.sql",
      dataSourceName: "prod_pg",
      datasetName: "sales",
    });
    expect(res.riskLevel).toBe("low");
    expect(res.sideEffects).toBe("read");
    expect(res.requiresApproval).toBe(false);
  });

  it("escalates edit_bento_slides with action=delete to high risk and requiresApproval", () => {
    const res = evaluateToolRisk("edit_bento_slides", {
      outcome_id: "deck-1",
      action: "delete",
      target_slide_ids: ["s1"],
    });
    expect(res.riskLevel).toBe("high");
    expect(res.sideEffects).toBe("destructive");
    expect(res.requiresApproval).toBe(true);
    expect(res.reason).toBe("Deleting slides from presentation");
  });

  it("escalates edit_bento_slides with stringified JSON action=delete to high risk", () => {
    const res = evaluateToolRisk(
      "edit_bento_slides",
      JSON.stringify({ outcome_id: "deck-1", action: "delete", target_slide_ids: ["s1"] }),
    );
    expect(res.riskLevel).toBe("high");
    expect(res.sideEffects).toBe("destructive");
    expect(res.requiresApproval).toBe(true);
  });

  it("keeps edit_bento_slides with action=replace/insert as low risk", () => {
    const resReplace = evaluateToolRisk("edit_bento_slides", {
      outcome_id: "deck-1",
      action: "replace",
      slides: [{ id: "s1", title: "Updated" }],
    });
    expect(resReplace.riskLevel).toBe("low");
    expect(resReplace.requiresApproval).toBe(false);

    const resInsert = evaluateToolRisk("edit_bento_slides", {
      outcome_id: "deck-1",
      action: "insert",
      slides: [{ id: "s2", title: "New" }],
    });
    expect(resInsert.riskLevel).toBe("low");
    expect(resInsert.requiresApproval).toBe(false);
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
      toolName: "run_ssh_command",
      code: "POLICY_DENIED",
      message: "Headless execution denied by policy",
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

describe("evaluateToolRisk — run_skill_script_on_ssh", () => {
  const base = { name: "k8s_ops", filename: "probe.sh", serverName: "prod-01" };

  it("registers as high / write but stays headless-allowed", () => {
    const res = evaluateToolRisk("run_skill_script_on_ssh", base);
    expect(res.riskLevel).toBe("high");
    expect(res.sideEffects).toBe("write");
    expect(res.headlessAllowed).toBe(true);
  });

  it("escalates to critical when a caller argument matches a dangerous SSH pattern", () => {
    for (const args of [["rm -rf /"], ["hello; shutdown -h now"], ["-f", "kill 9"]]) {
      const res = evaluateToolRisk("run_skill_script_on_ssh", { ...base, args });
      expect(res.riskLevel).toBe("critical");
      expect(res.sideEffects).toBe("destructive");
      expect(res.requiresApproval).toBe(true);
      expect(res.headlessAllowed).toBe(false);
      expect(res.reason).toContain("dangerous operation");
    }
  });

  // CONTRACT: the reviewed script bytes are never pattern-scanned — legitimate
  // operational scripts contain verbs like `rm`. Only `args` is LLM-authored.
  it("ignores dangerous text outside the args array", () => {
    const res = evaluateToolRisk("run_skill_script_on_ssh", {
      ...base,
      command: "rm -rf /",
      scriptText: "rm -rf /",
      args: ["--verbose"],
    });
    expect(res.riskLevel).toBe("high");
    expect(res.headlessAllowed).toBe(true);
  });

  it("tolerates missing or malformed args arrays", () => {
    for (const args of [undefined, "rm -rf /", [null, 42], []]) {
      const res = evaluateToolRisk("run_skill_script_on_ssh", { ...base, args });
      expect(res.riskLevel).toBe("high");
    }
  });
});
