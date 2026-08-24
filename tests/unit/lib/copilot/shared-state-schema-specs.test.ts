import { describe, it, expect } from "vitest";

import { VERIFICATION_ACTIVE_RESOURCE_SCHEMA } from "@/lib/verification/schema-spec";
import { WEB_AUTO_ACTIVE_RESOURCE_SCHEMA } from "@/lib/web-auto/schema-spec";
import { EVALUATION_ACTIVE_RESOURCE_SCHEMA } from "@/lib/evaluation/schema-spec";
import { SCHEDULE_ACTIVE_RESOURCE_SCHEMA } from "@/lib/runner/schedule-schema-spec";
import { AGENT_ACTIVE_RESOURCE_SCHEMA } from "@/lib/agents/schema-spec";
import { MCP_ACTIVE_RESOURCE_SCHEMA } from "@/lib/mcp/schema-spec";
import { SKILL_ACTIVE_RESOURCE_SCHEMA } from "@/lib/skills/schema-spec";
import { DATASOURCE_ACTIVE_RESOURCE_SCHEMA } from "@/lib/data-sources/schema-spec";
import { SSH_SERVER_ACTIVE_RESOURCE_SCHEMA } from "@/lib/ssh/schema-spec";
import { defaultSharedState } from "@/lib/copilot/shared-state-schema";

describe("Shared State Schema Specs Contract", () => {
  const ALL_SCHEMAS = [
    { name: "Verification", schema: VERIFICATION_ACTIVE_RESOURCE_SCHEMA, expectedType: "verification" },
    { name: "Web Auto", schema: WEB_AUTO_ACTIVE_RESOURCE_SCHEMA, expectedType: "web-auto" },
    { name: "Evaluation", schema: EVALUATION_ACTIVE_RESOURCE_SCHEMA, expectedType: "evaluation" },
    { name: "Schedule", schema: SCHEDULE_ACTIVE_RESOURCE_SCHEMA, expectedType: "schedule" },
    { name: "Agent", schema: AGENT_ACTIVE_RESOURCE_SCHEMA, expectedType: "agent" },
    { name: "MCP", schema: MCP_ACTIVE_RESOURCE_SCHEMA, expectedType: "mcp" },
    { name: "Skill", schema: SKILL_ACTIVE_RESOURCE_SCHEMA, expectedType: "skill" },
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
    expect(defaultSharedState.drafts).toEqual({});
  });

  it("validates shared state with activeResourceData containing any of the 9 schemas", () => {
    for (const { schema } of ALL_SCHEMAS) {
      const stateWithResource: typeof defaultSharedState = {
        context: {
          activeUrl: "/test",
          activeView: "agent",
          activeResourceId: "test-id",
          activeResourceData: {
            _schema: schema,
            sampleField: "sampleValue",
          },
        },
        drafts: {},
      };

      expect(stateWithResource.context.activeResourceData).toBeDefined();
      expect(stateWithResource.context.activeResourceData?._schema).toEqual(schema);
    }
  });

  it("validates shared state with drafts populated for all supported resource types", () => {
    const stateWithDrafts: typeof defaultSharedState = {
      context: defaultSharedState.context,
      drafts: {
        verification: { selectedCase: { name: "test-case" } },
        "web-auto": { selectedCase: { name: "web-test" } },
        evaluation: { selectedCase: { name: "eval-test" } },
        schedule: { task: "Run report" },
        agent: { name: "New Agent", model: "gpt-4o" },
        mcp: { selectedTool: { args: { query: "search" } } },
        skill: { name: "my-skill", skillMd: "..." },
        datasource: { name: "my_db", host: "localhost" },
        "ssh-server": { name: "my_host", host: "10.0.0.1" },
        workflow: { nodes: [], edges: [] },
      },
    };

    expect(Object.keys(stateWithDrafts.drafts)).toHaveLength(10);
    expect(stateWithDrafts.drafts.verification).toBeDefined();
    expect(stateWithDrafts.drafts["web-auto"]).toBeDefined();
    expect(stateWithDrafts.drafts.evaluation).toBeDefined();
    expect(stateWithDrafts.drafts.schedule).toBeDefined();
    expect(stateWithDrafts.drafts.agent).toBeDefined();
    expect(stateWithDrafts.drafts.mcp).toBeDefined();
    expect(stateWithDrafts.drafts.skill).toBeDefined();
    expect(stateWithDrafts.drafts.datasource).toBeDefined();
    expect(stateWithDrafts.drafts["ssh-server"]).toBeDefined();
  });
});
