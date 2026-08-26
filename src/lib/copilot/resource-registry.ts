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
  resourceType: ResourceType;
  urlPrefix: string;
  schema: Record<string, unknown>;
}

export const RESOURCE_REGISTRY: Record<ResourceType, ResourceDefinition> = {
  schedule: {
    resourceType: "schedule",
    urlPrefix: "/schedule",
    schema: SCHEDULE_ACTIVE_RESOURCE_SCHEMA,
  },
  skills: {
    resourceType: "skills",
    urlPrefix: "/skills",
    schema: SKILL_ACTIVE_RESOURCE_SCHEMA,
  },
  agent: {
    resourceType: "agent",
    urlPrefix: "/agent",
    schema: AGENT_ACTIVE_RESOURCE_SCHEMA,
  },
  datasource: {
    resourceType: "datasource",
    urlPrefix: "/datasource",
    schema: DATASOURCE_ACTIVE_RESOURCE_SCHEMA,
  },
  "ssh-server": {
    resourceType: "ssh-server",
    urlPrefix: "/ssh-server",
    schema: SSH_SERVER_ACTIVE_RESOURCE_SCHEMA,
  },
  mcp: {
    resourceType: "mcp",
    urlPrefix: "/mcp",
    schema: MCP_ACTIVE_RESOURCE_SCHEMA,
  },
  "web-auto": {
    resourceType: "web-auto",
    urlPrefix: "/web-auto",
    schema: WEB_AUTO_ACTIVE_RESOURCE_SCHEMA,
  },
  verification: {
    resourceType: "verification",
    urlPrefix: "/verification",
    schema: VERIFICATION_ACTIVE_RESOURCE_SCHEMA,
  },
  evaluation: {
    resourceType: "evaluation",
    urlPrefix: "/evaluation",
    schema: EVALUATION_ACTIVE_RESOURCE_SCHEMA,
  },
};

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

const RESOURCE_TYPE_ALIASES: Record<string, ResourceType> = {
  // Singular / Plural aliases
  skill: "skills",
  skills: "skills",
  schedule: "schedule",
  schedules: "schedule",
  agent: "agent",
  agents: "agent",
  "builtin-agent": "agent",
  "builtin_agent": "agent",
  "agent-editor": "agent",
  datasource: "datasource",
  datasources: "datasource",
  "data-source": "datasource",
  "data-sources": "datasource",
  "data_source": "datasource",
  "data_sources": "datasource",
  "ssh-server": "ssh-server",
  "ssh-servers": "ssh-server",
  "ssh_server": "ssh-server",
  "ssh_servers": "ssh-server",
  ssh: "ssh-server",
  mcp: "mcp",
  "mcp-server": "mcp",
  "mcp-tool": "mcp",
  "web-auto": "web-auto",
  "web_auto": "web-auto",
  webauto: "web-auto",
  "web-automation": "web-auto",
  verification: "verification",
  verifications: "verification",
  "verification-suite": "verification",
  evaluation: "evaluation",
  evaluations: "evaluation",
  eval: "evaluation",
  evals: "evaluation",
  "eval-suite": "evaluation",
};

/**
 * Normalizes user or LLM input string to canonical ResourceType with alias, plural, and separator tolerance.
 */
export function normalizeResourceType(input: string | null | undefined): ResourceType | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  if (isResourceType(trimmed)) return trimmed;
  if (RESOURCE_TYPE_ALIASES[trimmed]) return RESOURCE_TYPE_ALIASES[trimmed];
  const hyphenated = trimmed.replace(/_/g, "-");
  if (isResourceType(hyphenated)) return hyphenated;
  return RESOURCE_TYPE_ALIASES[hyphenated] ?? null;
}
