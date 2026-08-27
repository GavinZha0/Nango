/**
 * Resource Registry for Shared State and Co-Editing.
 * Single source of truth for resource types, URL mapping, and schema contracts.
 */

import { z } from "zod";
import {
  AGENT_ACTIVE_RESOURCE_SCHEMA,
  DATASOURCE_ACTIVE_RESOURCE_SCHEMA,
  EVALUATION_ACTIVE_RESOURCE_SCHEMA,
  MCP_ACTIVE_RESOURCE_SCHEMA,
  SCHEDULE_ACTIVE_RESOURCE_SCHEMA,
  SKILL_ACTIVE_RESOURCE_SCHEMA,
  SSH_SERVER_ACTIVE_RESOURCE_SCHEMA,
  VERIFICATION_ACTIVE_RESOURCE_SCHEMA,
  WEB_AUTO_ACTIVE_RESOURCE_SCHEMA,
  AgentDraftSchema,
  DataSourceDraftSchema,
  EvaluationDraftSchema,
  McpDraftSchema,
  ScheduleDraftSchema,
  SkillDraftSchema,
  SshServerDraftSchema,
  VerificationDraftSchema,
  WebAutoDraftSchema,
} from "./resource-schemas";

export * from "./resource-schemas";

export const RESOURCE_TYPES = [
  "schedule",
  "skills",
  "agent",
  "datasource",
  "ssh-server",
  "mcp",
  "web-auto",
  "verification",
  "evaluation",
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const resourceTypeSchema = z.enum(RESOURCE_TYPES);

export interface ResourceDefinition {
  schema: Record<string, unknown>;
  draftSchema: z.ZodTypeAny;
}

export const RESOURCE_REGISTRY: Record<ResourceType, ResourceDefinition> = {
  schedule: {
    schema: SCHEDULE_ACTIVE_RESOURCE_SCHEMA,
    draftSchema: ScheduleDraftSchema,
  },
  skills: {
    schema: SKILL_ACTIVE_RESOURCE_SCHEMA,
    draftSchema: SkillDraftSchema,
  },
  agent: {
    schema: AGENT_ACTIVE_RESOURCE_SCHEMA,
    draftSchema: AgentDraftSchema,
  },
  datasource: {
    schema: DATASOURCE_ACTIVE_RESOURCE_SCHEMA,
    draftSchema: DataSourceDraftSchema,
  },
  "ssh-server": {
    schema: SSH_SERVER_ACTIVE_RESOURCE_SCHEMA,
    draftSchema: SshServerDraftSchema,
  },
  mcp: {
    schema: MCP_ACTIVE_RESOURCE_SCHEMA,
    draftSchema: McpDraftSchema,
  },
  "web-auto": {
    schema: WEB_AUTO_ACTIVE_RESOURCE_SCHEMA,
    draftSchema: WebAutoDraftSchema,
  },
  verification: {
    schema: VERIFICATION_ACTIVE_RESOURCE_SCHEMA,
    draftSchema: VerificationDraftSchema,
  },
  evaluation: {
    schema: EVALUATION_ACTIVE_RESOURCE_SCHEMA,
    draftSchema: EvaluationDraftSchema,
  },
};

/** Get the canonical URL prefix for a resource type. */
export function getResourceUrlPrefix(type: ResourceType): string {
  return `/${type}`;
}

/**
 * Derive the ResourceType from a pathname (matching URL first segment).
 */
export function deriveResourceType(pathname: string): ResourceType | null {
  if (!pathname || pathname === "/") return null;
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment) return null;
  if ((RESOURCE_TYPES as readonly string[]).includes(segment)) {
    return segment as ResourceType;
  }
  return null;
}

export function isResourceType(value: string): value is ResourceType {
  return (RESOURCE_TYPES as readonly string[]).includes(value);
}
