import { describe, expect, it } from "vitest";

import {
  WORKFLOW_SCOPED_ERROR_CODES,
  WorkflowError,
  toResult,
  type WorkflowErrorCode,
  type WorkflowErrorResult,
} from "@/lib/workflows/error";

describe("WorkflowError", () => {
  it("captures all required + optional fields", () => {
    const cause = new Error("underlying boom");
    const we = new WorkflowError({
      errorCode: "PYTHON_RUNTIME_ERROR",
      message: "Python failed in node 1:\nKeyError: 'revenue'",
      nodeId: 1,
      nodeName: "run_code_in_sandbox",
      cause,
    });

    expect(we).toBeInstanceOf(Error);
    expect(we).toBeInstanceOf(WorkflowError);
    expect(we.name).toBe("WorkflowError");
    expect(we.errorCode).toBe("PYTHON_RUNTIME_ERROR");
    expect(we.message).toBe(
      "Python failed in node 1:\nKeyError: 'revenue'",
    );
    expect(we.nodeId).toBe(1);
    expect(we.nodeName).toBe("run_code_in_sandbox");
    // ES2022 native cause chain is preserved on the instance for
    // developer logs but stays off the wire envelope.
    expect(we.cause).toBe(cause);
  });

  it("permits omitted nodeId / nodeName for workflow-scoped errors", () => {
    const we = new WorkflowError({
      errorCode: "WORKFLOW_TIMEOUT",
      message: "Total exceeded 60000ms",
    });

    expect(we.nodeId).toBeUndefined();
    expect(we.nodeName).toBeUndefined();
    expect(we.cause).toBeUndefined();
  });

  it("treats the WORKFLOW_SCOPED_ERROR_CODES list as a closed set", () => {
    // Compile-time check: every entry is a valid WorkflowErrorCode.
    // Runtime check: the list isn't accidentally empty.
    const codes: readonly WorkflowErrorCode[] = WORKFLOW_SCOPED_ERROR_CODES;
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).toContain("SPEC_INVALID_JSON");
    expect(codes).toContain("WORKFLOW_TIMEOUT");
    expect(codes).toContain("UNKNOWN_ERROR");
    // Spot-check that a node-scoped code is NOT in the list.
    expect(codes).not.toContain("PYTHON_RUNTIME_ERROR");
    expect(codes).not.toContain("TOOL_NOT_FOUND");
  });
});

describe("toResult", () => {
  it("emits all populated fields with `error` (not `errorCode`) on the wire", () => {
    const we = new WorkflowError({
      errorCode: "PYTHON_RUNTIME_ERROR",
      message: "boom",
      nodeId: 2,
      nodeName: "run_code_in_sandbox",
    });

    const result: WorkflowErrorResult = toResult(we);
    expect(result).toEqual({
      ok: false,
      error: "PYTHON_RUNTIME_ERROR",
      message: "boom",
      nodeId: 2,
      nodeName: "run_code_in_sandbox",
    });
  });

  it("omits absent optional fields (workflow-scoped error)", () => {
    const we = new WorkflowError({
      errorCode: "SPEC_DAG_CYCLE",
      message: "cycle: 0 → 1 → 0",
    });

    const result = toResult(we);
    expect(result).toEqual({
      ok: false,
      error: "SPEC_DAG_CYCLE",
      message: "cycle: 0 → 1 → 0",
    });
    expect("nodeId" in result).toBe(false);
    expect("nodeName" in result).toBe(false);
  });

  it("does NOT serialize the `cause` field onto the wire result", () => {
    // cause is a developer-log diagnostic, not part of the LLM /
    // admin / HTTP contract. The wire shape must stay minimal.
    const we = new WorkflowError({
      errorCode: "TOOL_EXECUTION_FAILED",
      message: "tool returned non-2xx",
      nodeId: 0,
      nodeName: "http_request",
      cause: new Error("connect ECONNREFUSED"),
    });

    const result = toResult(we);
    expect("cause" in result).toBe(false);
  });

  it("preserves nodeId === 0 (falsy-number safety)", () => {
    // Defensive: a `nodeId: number | undefined` field is easy to
    // accidentally drop with `if (we.nodeId)` instead of
    // `if (we.nodeId !== undefined)`. The save pipeline starts at
    // id=0, so this case shows up in real runs.
    const we = new WorkflowError({
      errorCode: "PYTHON_RUNTIME_ERROR",
      message: "first node failed",
      nodeId: 0,
      nodeName: "extract_dataset_by_sql",
    });

    const result = toResult(we);
    expect(result.nodeId).toBe(0);
  });
});
