import { describe, it, expect } from "vitest";
import {
  RESOURCE_REGISTRY,
  RESOURCE_TYPES,
  deriveResourceType,
  isResourceType,
  resourceTypeSchema,
  getResourceUrlPrefix,
  DRAFT_SCHEMAS,
} from "@/lib/copilot/resource-registry";

describe("Resource Registry and URL Derivation Contract", () => {
  it("defines all 9 active resource types matching registry keys and draft schemas", () => {
    expect(RESOURCE_TYPES).toHaveLength(9);
    expect(Object.keys(RESOURCE_REGISTRY)).toHaveLength(9);
    expect(Object.keys(DRAFT_SCHEMAS)).toHaveLength(9);

    for (const type of RESOURCE_TYPES) {
      expect(RESOURCE_REGISTRY[type]).toBeDefined();
      expect(RESOURCE_REGISTRY[type].schema).toBeDefined();
      expect(RESOURCE_REGISTRY[type].draftSchema).toBeDefined();
      expect(getResourceUrlPrefix(type)).toBe(`/${type}`);
      expect(DRAFT_SCHEMAS[type]).toBeDefined();
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

  it("validates isResourceType guard function and resourceTypeSchema", () => {
    expect(isResourceType("schedule")).toBe(true);
    expect(isResourceType("skills")).toBe(true);
    expect(isResourceType("agent")).toBe(true);
    expect(isResourceType("unknown-type")).toBe(false);

    expect(resourceTypeSchema.safeParse("skills").success).toBe(true);
    expect(resourceTypeSchema.safeParse("schedule").success).toBe(true);
    expect(resourceTypeSchema.safeParse("invalid").success).toBe(false);
  });
});
