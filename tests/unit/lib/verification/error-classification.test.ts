import { describe, expect, it } from "vitest";
import { classifyMcpError } from "@/lib/verification/error-source";
import { toToolFailure } from "@/lib/runner/tool-failure";

describe("classifyMcpError and numeric code support", () => {
  it("classifies -32001 as timeout", () => {
    const err = new Error("Call tool timed out");
    (err as unknown as { code: number }).code = -32001;

    const envelope = classifyMcpError(err);
    expect(envelope.source).toBe("timeout");
    expect(envelope.details?.code).toBe(-32001);
  });

  it("classifies -32000 as transport error", () => {
    const err = new Error("Connection dropped");
    (err as unknown as { code: number }).code = -32000;

    const envelope = classifyMcpError(err);
    expect(envelope.source).toBe("transport");
    expect(envelope.details?.code).toBe(-32000);
  });

  it("classifies failure cooldown as transport", () => {
    const err = new Error(
      "MCP server crm-1 is in failure cooldown for 25s more; skipping borrow",
    );
    const envelope = classifyMcpError(err);
    expect(envelope.source).toBe("transport");
    expect(envelope.details?.cooldown).toBe(true);
  });

  it("classifies TimeoutError name as timeout", () => {
    const err = new Error("The operation timed out");
    err.name = "TimeoutError";
    const envelope = classifyMcpError(err);
    expect(envelope.source).toBe("timeout");
    expect(envelope.details?.name).toBe("TimeoutError");
  });

  it("classifies text-only timeout message without code as transport to protect three-state contract", () => {
    const err = new Error("upstream gateway timed out");
    const envelope = classifyMcpError(err);
    expect(envelope.source).toBe("transport");
    expect(envelope.details?.unconfirmedTimeout).toBe(true);
  });

  it("preserves numeric codes through toToolFailure", () => {
    const err = new Error("JSON-RPC request timeout");
    (err as unknown as { code: number }).code = -32001;

    const failure = toToolFailure(err, "test_tool");
    expect(failure.isError).toBe(true);

    // Read the symbol
    const symbolKey = Symbol.for("nango.toolFailureCause");
    const cause = (failure as unknown as Record<symbol, { code?: number | string }>)[symbolKey];
    expect(cause).toBeDefined();
    expect(cause.code).toBe(-32001);
  });

  it("classifies standard ECONNREFUSED as transport", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    (err as unknown as { code: string }).code = "ECONNREFUSED";

    const envelope = classifyMcpError(err);
    expect(envelope.source).toBe("transport");
  });

  it("classifies HTTP 4xx and 5xx as endpoint error with httpStatus", () => {
    const err401 = new Error("Unauthorized");
    (err401 as unknown as { status: number }).status = 401;
    const env401 = classifyMcpError(err401);
    expect(env401.source).toBe("endpoint");
    expect(env401.details?.httpStatus).toBe(401);

    const err502 = new Error("Bad Gateway");
    (err502 as unknown as { statusCode: number }).statusCode = 502;
    const env502 = classifyMcpError(err502);
    expect(env502.source).toBe("endpoint");
    expect(env502.details?.httpStatus).toBe(502);
  });

  it("classifies JSON-RPC numeric code as protocol error", () => {
    const err = new Error("Invalid params");
    (err as unknown as { code: number }).code = -32602;

    const envelope = classifyMcpError(err);
    expect(envelope.source).toBe("protocol");
    expect(envelope.details?.code).toBe(-32602);
  });

  it("preserves data and numeric code in toToolFailure cause", () => {
    const err = new Error("Validation failed");
    (err as unknown as { code: number; data: unknown }).code = -32602;
    (err as unknown as { code: number; data: unknown }).data = { field: "email", reason: "invalid" };

    const failure = toToolFailure(err, "register_user");
    expect(failure.isError).toBe(true);

    const symbolKey = Symbol.for("nango.toolFailureCause");
    const cause = (failure as unknown as Record<symbol, { code?: number | string; data?: unknown }>)[symbolKey];
    expect(cause).toBeDefined();
    expect(cause.code).toBe(-32602);
    expect(cause.data).toEqual({ field: "email", reason: "invalid" });
  });
});
