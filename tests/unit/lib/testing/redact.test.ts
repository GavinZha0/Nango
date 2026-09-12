import { describe, it, expect } from "vitest";
import { redactSensitiveData, redactErrorEnvelope } from "@/lib/testing/redact";

describe("redactSensitiveData", () => {
  it("returns input as-is if sensitiveValues is empty or null", () => {
    expect(redactSensitiveData("test string", new Set())).toBe("test string");
    expect(redactSensitiveData({ a: 1 }, new Set())).toEqual({ a: 1 });
    expect(redactSensitiveData(null, new Set(["password"]))).toBeNull();
    expect(redactSensitiveData(undefined, new Set(["password"]))).toBeUndefined();
  });

  it("replaces exact sensitive strings with ******", () => {
    const sensitive = new Set(["super_secret_password"]);
    const text = "User logged in with password super_secret_password successfully";
    expect(redactSensitiveData(text, sensitive)).toBe(
      "User logged in with password ****** successfully",
    );
  });

  it("prevents prefix truncation by strictly sorting targets in descending length order", () => {
    // Both long and short string share the same prefix
    const sensitive = new Set(["admin123", "admin123456"]);
    const text = "First is admin123456 and second is admin123.";

    const redacted = redactSensitiveData(text, sensitive);
    // admin123456 must NOT be truncated to "******456"
    expect(redacted).toBe("First is ****** and second is ******.");
    expect(redacted).not.toContain("456");
  });

  it("ignores strings under MIN_SENSITIVE_LENGTH (4) to prevent false-positive masking", () => {
    const sensitive = new Set(["abc", "123", "dev"]);
    const text = "Development environment for abc on port 123";
    expect(redactSensitiveData(text, sensitive)).toBe(text);
  });

  it("recursively redacts nested objects and arrays", () => {
    const sensitive = new Set(["secretToken999"]);
    const input = {
      header: "Authorization: Bearer secretToken999",
      items: [
        "token: secretToken999",
        { deepToken: "secretToken999", count: 42 },
      ],
      numeric: 12345,
      flag: true,
    };

    const expected = {
      header: "Authorization: Bearer ******",
      items: [
        "token: ******",
        { deepToken: "******", count: 42 },
      ],
      numeric: 12345,
      flag: true,
    };

    expect(redactSensitiveData(input, sensitive)).toEqual(expected);
  });
});

describe("redactErrorEnvelope", () => {
  it("redacts message and details inside an ErrorEnvelope", () => {
    const sensitive = new Set(["my_hidden_key_value"]);
    const error = {
      source: "upstream",
      message: "Connection failed with key my_hidden_key_value",
      details: {
        rawResponse: "Error for key my_hidden_key_value at /endpoint",
        code: 401,
      },
    };

    const redacted = redactErrorEnvelope(error, sensitive);
    expect(redacted?.message).toBe("Connection failed with key ******");
    expect((redacted?.details as Record<string, unknown>).rawResponse).toBe(
      "Error for key ****** at /endpoint",
    );
  });

  it("handles null or undefined errors safely", () => {
    expect(redactErrorEnvelope(null, new Set(["secret"]))).toBeNull();
    expect(redactErrorEnvelope(undefined, new Set(["secret"]))).toBeUndefined();
  });
});
