import { describe, expect, it } from "vitest";
import {
  isAnonymousPlaceholder,
  buildAuthHeaders,
} from "@/lib/backends/bridge-runtime-kit.server";

describe("isAnonymousPlaceholder", () => {
  it("identifies null, undefined, and empty string as placeholder", () => {
    expect(isAnonymousPlaceholder(null)).toBe(true);
    expect(isAnonymousPlaceholder(undefined)).toBe(true);
    expect(isAnonymousPlaceholder("")).toBe(true);
    expect(isAnonymousPlaceholder("   ")).toBe(true);
  });

  it("identifies standard placeholder strings case-insensitively", () => {
    expect(isAnonymousPlaceholder("empty")).toBe(true);
    expect(isAnonymousPlaceholder("Empty")).toBe(true);
    expect(isAnonymousPlaceholder("EMPTY")).toBe(true);
    expect(isAnonymousPlaceholder("none")).toBe(true);
    expect(isAnonymousPlaceholder("None")).toBe(true);
    expect(isAnonymousPlaceholder("null")).toBe(true);
    expect(isAnonymousPlaceholder("dummy")).toBe(true);
    expect(isAnonymousPlaceholder("no_auth")).toBe(true);
    expect(isAnonymousPlaceholder("anonymous")).toBe(true);
    expect(isAnonymousPlaceholder("Anonymous")).toBe(true);
    expect(isAnonymousPlaceholder("na")).toBe(true);
    expect(isAnonymousPlaceholder("n/a")).toBe(true);
    expect(isAnonymousPlaceholder("N/A")).toBe(true);
    expect(isAnonymousPlaceholder("disabled")).toBe(true);
    expect(isAnonymousPlaceholder("undefined")).toBe(true);
    expect(isAnonymousPlaceholder("  empty  ")).toBe(true);
  });

  it("returns false for genuine tokens", () => {
    expect(isAnonymousPlaceholder("sk-1234567890")).toBe(false);
    expect(isAnonymousPlaceholder("bearer_abc")).toBe(false);
    expect(isAnonymousPlaceholder("eyJhbGciOiJIUzI1Ni...").valueOf()).toBe(false);
    expect(isAnonymousPlaceholder("my_secret_token")).toBe(false);
  });
});

describe("buildAuthHeaders", () => {
  it("returns empty object when token is null, undefined, or a placeholder", () => {
    expect(buildAuthHeaders(null)).toEqual({});
    expect(buildAuthHeaders(undefined)).toEqual({});
    expect(buildAuthHeaders("")).toEqual({});
    expect(buildAuthHeaders("empty")).toEqual({});
    expect(buildAuthHeaders("none")).toEqual({});
    expect(buildAuthHeaders("dummy")).toEqual({});
    expect(buildAuthHeaders("anonymous")).toEqual({});
    expect(buildAuthHeaders("n/a")).toEqual({});
  });

  it("constructs Authorization: Bearer <token> for genuine tokens by default", () => {
    expect(buildAuthHeaders("sk-secret-key")).toEqual({
      Authorization: "Bearer sk-secret-key",
    });
    expect(buildAuthHeaders("  sk-secret-key  ")).toEqual({
      Authorization: "Bearer sk-secret-key",
    });
  });

  it("constructs X-API-Key by default when type is api_key (Option B)", () => {
    expect(buildAuthHeaders("api-key-value", "api_key")).toEqual({
      "X-API-Key": "api-key-value",
    });
    expect(buildAuthHeaders("api-key-value", "api_key", null)).toEqual({
      "X-API-Key": "api-key-value",
    });
  });

  it("constructs custom header directly when specified for api_key", () => {
    expect(buildAuthHeaders("api-key-value", "api_key", "x-api-key")).toEqual({
      "x-api-key": "api-key-value",
    });
    expect(buildAuthHeaders("api-key-value", "api_key", "X-Subscription-Token")).toEqual({
      "X-Subscription-Token": "api-key-value",
    });
  });

  it("formats as Bearer when headerName is Authorization for api_key", () => {
    expect(buildAuthHeaders("api-key-value", "api_key", "Authorization")).toEqual({
      Authorization: "Bearer api-key-value",
    });
    expect(buildAuthHeaders("api-key-value", "api_key", "authorization")).toEqual({
      Authorization: "Bearer api-key-value",
    });
  });

  it("always returns empty object for placeholder tokens regardless of type or headerName", () => {
    expect(buildAuthHeaders("empty", "api_key")).toEqual({});
    expect(buildAuthHeaders("none", "api_key", "X-Custom-Auth")).toEqual({});
    expect(buildAuthHeaders("anonymous", "api_key", "Authorization")).toEqual({});
  });
});
