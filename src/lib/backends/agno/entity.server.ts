/**
 * agno entity discovery — server-only. See docs/backend-integration.md.
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";
import type { EntityDescriptor, EntityKind } from "../types";

const log = childLogger({ component: "agno-entity-fetcher" });

/** Raw agno agent shape — only the fields we read. */
interface AgnoAgentRaw {
  id: string;
  name?: string;
  description?: string;
  role?: string;
  db_id?: string;
  model?: { name?: string; model?: string; provider?: string };
  tools?: { tools?: Array<{ name?: string; description?: string }> };
  knowledge?: unknown;
  /** agno embeds the full system prompt here. */
  system_message?: { instructions?: string; markdown?: boolean; [k: string]: unknown };
  memory?: { metadata?: { visible?: boolean } } & Record<string, unknown>;
  /** `version` is `unknown` — upstream Python dict may emit string, number, or omit. */
  metadata?: { visible?: boolean; version?: unknown } & Record<string, unknown>;
  [k: string]: unknown;
}

interface AgnoTeamRaw extends AgnoAgentRaw {
  members?: unknown[];
}

/** Mirrors agno's `WorkflowSummaryResponse` (`agno/os/schema.py`). */
interface AgnoWorkflowRaw {
  id: string;
  name?: string;
  description?: string;
  db_id?: string;
  is_factory?: boolean;
  factory_input_schema?: Record<string, unknown> | null;
  is_component?: boolean;
  current_version?: number | null;
  stage?: string | null;
  [k: string]: unknown;
}

function projectAgent(
  raw: AgnoAgentRaw,
  credentialId: string,
  kind: EntityKind,
): EntityDescriptor {
  const model =
    raw.model && raw.model.model
      ? {
          id: raw.model.model,
          // Only emit a separate displayName when agno's class label
          // (e.g. "OpenAIResponses") differs from the model id.
          displayName:
            raw.model.name && raw.model.name !== raw.model.model
              ? raw.model.name
              : undefined,
          provider: raw.model.provider,
        }
      : undefined;

  const toolCount = raw.tools?.tools?.length ?? 0;
  const prompt =
    typeof raw.system_message?.instructions === "string"
      ? raw.system_message.instructions
      : undefined;

  const kbCount = Array.isArray(raw.knowledge) ? raw.knowledge.length : 0;

  // Accept string or number from the upstream Python dict.
  const rawVersion: unknown = raw.metadata?.version;
  const version: string | undefined =
    typeof rawVersion === "string" && rawVersion.length > 0
      ? rawVersion
      : typeof rawVersion === "number"
        ? String(rawVersion)
        : undefined;

  return {
    id: raw.id,
    kind,
    name: raw.name,
    description: raw.description,
    role: raw.role,
    prompt,
    version,
    provider: "agno",
    credentialId,
    model,
    toolCount,
    skillCount: 0,
    kbCount,
    dbId: raw.db_id,
    raw: raw as Record<string, unknown>,
  };
}

function projectWorkflow(
  raw: AgnoWorkflowRaw,
  credentialId: string,
): EntityDescriptor {
  // Stringify so it matches semver-style versions from other backends.
  const version: string | undefined =
    raw.current_version != null ? String(raw.current_version) : undefined;

  return {
    id: raw.id,
    kind: "workflow",
    name: raw.name,
    description: raw.description,
    version,
    provider: "agno",
    credentialId,
    dbId: raw.db_id,
    raw: raw as Record<string, unknown>,
  };
}

/** agno hides team members / other agents via `metadata.visible = false` or `memory.metadata.visible = false`. */
function isAgnoVisible(a: AgnoAgentRaw): boolean {
  const memVis = a.memory?.metadata?.visible;
  const metaVis = a.metadata?.visible;
  return memVis !== false && metaVis !== false;
}

/**
 * Fetch agno's `/agents` + `/teams` + `/workflows` directly. Each
 * sub-failure degrades to an empty list rather than aborting the call.
 */
export async function fetchAgnoEntitiesServer(
  credentialId: string,
  baseUrl: string,
  token: string,
): Promise<EntityDescriptor[]> {
  const headers: HeadersInit = { Authorization: `Bearer ${token}` };

  const safeFetch = async <T>(path: string): Promise<T[] | null> => {
    try {
      const res = await fetch(`${baseUrl}${path}`, { headers });
      if (!res.ok) {
        log.warn(
          { event: "agno_list_failed", path, status: res.status, credentialId },
          "agno upstream list returned non-2xx",
        );
        return null;
      }
      const json = (await res.json()) as unknown;
      return Array.isArray(json) ? (json as T[]) : null;
    } catch (err) {
      log.warn(
        {
          event: "agno_list_failed",
          path,
          credentialId,
          err: err instanceof Error ? err.message : String(err),
        },
        "agno upstream list threw",
      );
      return null;
    }
  };

  const [agents, teams, workflows] = await Promise.all([
    safeFetch<AgnoAgentRaw>("/agents"),
    safeFetch<AgnoTeamRaw>("/teams"),
    safeFetch<AgnoWorkflowRaw>("/workflows"),
  ]);

  const out: EntityDescriptor[] = [];
  for (const a of (agents ?? []).filter(isAgnoVisible)) {
    out.push(projectAgent(a, credentialId, "agent"));
  }
  for (const t of (teams ?? []).filter(isAgnoVisible)) {
    out.push({
      ...projectAgent(t, credentialId, "team"),
      memberCount: Array.isArray(t.members) ? t.members.length : undefined,
    });
  }
  for (const w of workflows ?? []) {
    out.push(projectWorkflow(w, credentialId));
  }
  return out;
}
