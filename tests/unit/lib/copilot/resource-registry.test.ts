import { describe, it, expect } from "vitest";
import {
  RESOURCE_REGISTRY,
  RESOURCE_TYPES,
  deriveResourceType,
  isResourceType,
  normalizeResourceType,
} from "@/lib/copilot/resource-registry";

describe("Resource Registry and URL Derivation Contract", () => {
  it("defines all 9 active resource types matching registry keys", () => {
    expect(RESOURCE_TYPES).toHaveLength(9);
    expect(Object.keys(RESOURCE_REGISTRY)).toHaveLength(9);

    for (const type of RESOURCE_TYPES) {
      expect(RESOURCE_REGISTRY[type]).toBeDefined();
      expect(RESOURCE_REGISTRY[type].resourceType).toBe(type);
      expect(RESOURCE_REGISTRY[type].urlPrefix).toBe(`/${type}`);
    }
  });

  it("correctly derives resourceType from URL paths", () => {
    expect(deriveResourceType("/schedule")).toBe("schedule");
    expect(deriveResourceType("/schedule/123-uuid")).toBe("schedule");
    expect(deriveResourceType("/skills")).toBe("skills");
    expect(deriveResourceType("/skills/csv-analyst")).toBe("skills");
    expect(deriveResourceType("/agent")).toBe("agent");
    expect(deriveResourceType("/agent/abc-id")).toBe("agent");
    expect(deriveResourceType("/datasource/my-db")).toBe("datasource");
    expect(deriveResourceType("/ssh-server/host-1")).toBe("ssh-server");
    expect(deriveResourceType("/mcp/test/123")).toBe("mcp");
    expect(deriveResourceType("/web-auto/suite-1")).toBe("web-auto");
    expect(deriveResourceType("/verification/server/1")).toBe("verification");
    expect(deriveResourceType("/evaluation/eval-1")).toBe("evaluation");
  });

  it("returns null for non-resource or root paths", () => {
    expect(deriveResourceType("/")).toBeNull();
    expect(deriveResourceType("")).toBeNull();
    expect(deriveResourceType("/dashboard")).toBeNull();
    expect(deriveResourceType("/notifications")).toBeNull();
    expect(deriveResourceType("/profile")).toBeNull();
  });

  it("validates isResourceType guard function", () => {
    expect(isResourceType("schedule")).toBe(true);
    expect(isResourceType("skills")).toBe(true);
    expect(isResourceType("agent")).toBe(true);
    expect(isResourceType("unknown-type")).toBe(false);
  });

  it("normalizes diverse user/LLM input strings with singular/plural and separator tolerance", () => {
    // Exact canonical
    expect(normalizeResourceType("skills")).toBe("skills");
    expect(normalizeResourceType("schedule")).toBe("schedule");

    // Singular / Plural
    expect(normalizeResourceType("skill")).toBe("skills");
    expect(normalizeResourceType("schedules")).toBe("schedule");
    expect(normalizeResourceType("agents")).toBe("agent");
    expect(normalizeResourceType("datasources")).toBe("datasource");
    expect(normalizeResourceType("evals")).toBe("evaluation");
    expect(normalizeResourceType("verifications")).toBe("verification");

    // Separator / Case variations
    expect(normalizeResourceType("ssh_server")).toBe("ssh-server");
    expect(normalizeResourceType("SSH-SERVER")).toBe("ssh-server");
    expect(normalizeResourceType("data_source")).toBe("datasource");
    expect(normalizeResourceType("data-source")).toBe("datasource");
    expect(normalizeResourceType("web_auto")).toBe("web-auto");
    expect(normalizeResourceType("webauto")).toBe("web-auto");
    expect(normalizeResourceType("builtin_agent")).toBe("agent");

    // Invalid or unknown
    expect(normalizeResourceType("random_page")).toBeNull();
    expect(normalizeResourceType("")).toBeNull();
    expect(normalizeResourceType(null)).toBeNull();
  });
});
