import { describe, it, expect } from "vitest";
import {
  toBackendCredentials,
  getCapabilities,
  hasEntityKind,
  type BackendCredentialInfo,
} from "@/lib/backends/facade";

describe("toBackendCredentials", () => {
  it("filters to supported providers only", () => {
    const input = [
      { id: "1", name: "Agno Prod", provider: "agno" },
      { id: "2", name: "Mastra Dev", provider: "mastra" },
      { id: "3", name: "OpenAI Key", provider: "openai" },
      { id: "4", name: "No Provider", provider: null },
    ];
    const result = toBackendCredentials(input);
    expect(result).toEqual([
      { credentialId: "1", name: "Agno Prod", provider: "agno" },
      { credentialId: "2", name: "Mastra Dev", provider: "mastra" },
    ]);
  });

  it("returns empty array for no matching providers", () => {
    const input = [
      { id: "1", name: "OpenAI", provider: "openai" },
      { id: "2", name: "Null", provider: null },
    ];
    expect(toBackendCredentials(input)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(toBackendCredentials([])).toEqual([]);
  });
});

describe("getCapabilities", () => {
  it("returns capabilities for a supported provider", () => {
    const caps = getCapabilities("agno");
    expect(caps).not.toBeNull();
    expect(caps!.displayName).toBeTruthy();
    expect(caps!.entityKinds).toBeInstanceOf(Array);
  });

  it("returns null for an unknown provider", () => {
    expect(getCapabilities("unknown")).toBeNull();
    expect(getCapabilities(null)).toBeNull();
    expect(getCapabilities(undefined)).toBeNull();
  });
});

describe("hasEntityKind", () => {
  const creds: BackendCredentialInfo[] = [
    { credentialId: "1", name: "Agno", provider: "agno" },
  ];

  it("returns true when the provider supports the kind", () => {
    expect(hasEntityKind(creds, "agent")).toBe(true);
  });

  it("returns false for empty credentials", () => {
    expect(hasEntityKind([], "agent")).toBe(false);
  });
});
