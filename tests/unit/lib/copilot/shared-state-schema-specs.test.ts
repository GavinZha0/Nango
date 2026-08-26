import { describe, it, expect } from "vitest";

import {
  VERIFICATION_ACTIVE_RESOURCE_SCHEMA,
  WEB_AUTO_ACTIVE_RESOURCE_SCHEMA,
  EVALUATION_ACTIVE_RESOURCE_SCHEMA,
  SCHEDULE_ACTIVE_RESOURCE_SCHEMA,
  AGENT_ACTIVE_RESOURCE_SCHEMA,
  MCP_ACTIVE_RESOURCE_SCHEMA,
  SKILL_ACTIVE_RESOURCE_SCHEMA,
  DATASOURCE_ACTIVE_RESOURCE_SCHEMA,
  SSH_SERVER_ACTIVE_RESOURCE_SCHEMA,
} from "@/lib/copilot/resource-schemas";
import { defaultSharedState } from "@/lib/copilot/shared-state-schema";

describe("Shared State Schema Specs Contract", () => {
  const ALL_SCHEMAS = [
    { name: "Verification", schema: VERIFICATION_ACTIVE_RESOURCE_SCHEMA, expectedType: "verification" },
    { name: "Web Auto", schema: WEB_AUTO_ACTIVE_RESOURCE_SCHEMA, expectedType: "web-auto" },
    { name: "Evaluation", schema: EVALUATION_ACTIVE_RESOURCE_SCHEMA, expectedType: "evaluation" },
    { name: "Schedule", schema: SCHEDULE_ACTIVE_RESOURCE_SCHEMA, expectedType: "schedule" },
    { name: "Agent", schema: AGENT_ACTIVE_RESOURCE_SCHEMA, expectedType: "agent" },
    { name: "MCP", schema: MCP_ACTIVE_RESOURCE_SCHEMA, expectedType: "mcp" },
    { name: "Skill", schema: SKILL_ACTIVE_RESOURCE_SCHEMA, expectedType: "skills" },
    { name: "DataSource", schema: DATASOURCE_ACTIVE_RESOURCE_SCHEMA, expectedType: "datasource" },
    { name: "SSH Server", schema: SSH_SERVER_ACTIVE_RESOURCE_SCHEMA, expectedType: "ssh-server" },
  ];

  it("exports all 9 active resource schemas with valid version and properties", () => {
    expect(ALL_SCHEMAS).toHaveLength(9);

    for (const { name, schema, expectedType } of ALL_SCHEMAS) {
      expect(schema.version, `${name} must have version 1.0`).toBe("1.0");
      expect(schema.resourceType, `${name} resourceType must match ${expectedType}`).toBe(expectedType);
      expect(typeof schema.description, `${name} must have description`).toBe("string");
      expect(schema.description.length).toBeGreaterThan(10);
      expect(typeof schema.properties, `${name} must have properties object`).toBe("object");
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
    }
  });

  it("has defaultSharedState with valid structure and empty context", () => {
    expect(defaultSharedState).toBeDefined();
    expect(defaultSharedState.context.activeUrl).toBe("/");
    expect(defaultSharedState.context.activeView).toBe("none");
    expect(defaultSharedState.context.activeResourceId).toBeNull();
    expect(defaultSharedState.context.activeResourceData).toBeNull();
  });

  it("validates shared state with activeResourceData containing pure dynamic payload", () => {
    for (const { expectedType } of ALL_SCHEMAS) {
      const stateWithResource: typeof defaultSharedState = {
        context: {
          activeUrl: `/${expectedType}/test-id`,
          activeView: expectedType as typeof defaultSharedState.context.activeView,
          activeResourceId: "test-id",
          activeResourceData: {
            name: `Test ${expectedType}`,
            sampleField: "sampleValue",
          },
        },
      };

      expect(stateWithResource.context.activeResourceData).toBeDefined();
      expect(stateWithResource.context.activeResourceData?.name).toBe(`Test ${expectedType}`);
    }
  });
});
