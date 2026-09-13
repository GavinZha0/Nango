import { describe, it, expect } from "vitest";
import { classifyError } from "@/lib/copilot/classify-error";

describe("classifyError", () => {
  it("classifies HTTP 401 as system error", () => {
    const res = classifyError(new Error("HTTP 401: Unauthorized session"));
    expect(res.scope).toBe("system");
    expect(res.status).toBe(401);
    expect(res.message).toBe("Your session has expired. Please sign in again.");
  });

  it("classifies HTTP 403 as system error", () => {
    const res = classifyError({ message: "HTTP 403: Forbidden access" });
    expect(res.scope).toBe("system");
    expect(res.status).toBe(403);
    expect(res.message).toContain("Access denied");
  });

  it("classifies network offline as system error", () => {
    const res = classifyError(new Error("Failed to fetch"));
    expect(res.scope).toBe("system");
    expect(res.message).toContain("Network connection lost");
  });

  it("classifies model 404 as session error", () => {
    const res = classifyError(
      new Error("The model `meta-llama/llama-4` does not exist (HTTP 404)"),
    );
    expect(res.scope).toBe("session");
    expect(res.status).toBe(404);
    expect(res.message).toContain("meta-llama/llama-4");
  });

  it("classifies 429 rate limit as session error", () => {
    const res = classifyError({ message: "HTTP 429: Rate limit exceeded" });
    expect(res.scope).toBe("session");
    expect(res.status).toBe(429);
    expect(res.message).toContain("Rate limit reached");
  });

  it("classifies HTTP 503 service unavailable as system error", () => {
    const res = classifyError({ message: "HTTP 503: Service Unavailable" });
    expect(res.scope).toBe("system");
    expect(res.status).toBe(503);
    expect(res.message).toContain("No built-in agents or services are available");
  });

  it("classifies generic 500 runtime failure as session error", () => {
    const res = classifyError(new Error("Internal error occurred"));
    expect(res.scope).toBe("session");
    expect(res.message).toBe("Internal error occurred");
  });
});
