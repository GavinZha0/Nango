/**
 * agno entity discovery — server-only.
 *
 * @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";
import type { EntityDescriptor, EntityKind } from "../types";

const log = childLogger({ component: "agno-entity-fetcher" });

// Raw upstream shapes (only the fields we read)

/** Raw agno agent shape. All other fields go into `EntityDescriptor.raw`. */
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
  /** Visibility hints — see `isAgnoVisible` below. */
  memory?: { metadata?: { visible?: boolean } } & Record<string, unknown>;
  /**
   * Free-form metadata bag. We read `visible` (visibility filter) and
   * `version` (the upstream agent's version label, surfaced in the UI
   * via EntityDescriptor.version). `version` is intentionally typed as
   * `unknown` because the upstream is a Python dict — callers may write
   * a string ("1.2.0"), a number (1), or omit it entirely; normalization
   * happens in `projectAgent` below.
   */
  metadata?: { visible?: boolean; version?: unknown } & Record<string, unknown>;
  [k: string]: unknown;
}

/** Raw agno team shape — same fields as agent + a `members` list. */
interface AgnoTeamRaw extends AgnoAgentRaw {
  members?: unknown[];
}

/** Raw agno workflow shape. Mirrors the Pydantic
 *  `WorkflowSummaryResponse` model (`agno/os/schema.py`). */
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

// Projection

/** Project an agno raw agent / team object onto the canonical shape.
 *  Used by both agent and team listings. */
function projectAgent(
  raw: AgnoAgentRaw,
  credentialId: string,
  kind: EntityKind,
): EntityDescriptor {
  const model =
    raw.model && raw.model.model
      ? {
          id: raw.model.model,
          // Only set a separate displayName when agno's class label
          // (e.g. "OpenAIResponses") differs from the model id.
          displayName:
            raw.model.name && raw.model.name !== raw.model.model
              ? raw.model.name
              : undefined,
          provider: raw.model.provider,
        }
      : undefined;

  const toolCount = raw.tools?.tools?.length ?? 0;
  // agno embeds the full system prompt under `system_message.instructions`.
  const prompt =
    typeof raw.system_message?.instructions === "string"
      ? raw.system_message.instructions
      : undefined;

  // Knowledge bases — agno's `knowledge` shape varies; if it's an
  // array, count entries; otherwise leave 0.
  const kbCount = Array.isArray(raw.knowledge) ? raw.knowledge.length : 0;

  // Version label from agno-side `metadata.version`. Upstream is a
  // Python dict so the value type is unknown — accept string or number,
  // ignore anything else (including empty string). Workflows use a
  // different field (`current_version`); see `projectWorkflow` below.
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

/** Project an agno workflow summary onto the canonical EntityDescriptor. */
function projectWorkflow(
  raw: AgnoWorkflowRaw,
  credentialId: string,
): EntityDescriptor {
  // agno stores `current_version` as a numeric (e.g. 1, 2) — stringify
  // so it shares the same canonical `string` type as future semver-style
  // versions from other backends, and so the UI chip rendering is
  // uniform across providers.
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

/** True iff the agno agent / team is visible. agno hides team members
 *  and other agents via `metadata.visible = false` or
 *  `memory.metadata.visible = false`. */
function isAgnoVisible(a: AgnoAgentRaw): boolean {
  const memVis = a.memory?.metadata?.visible;
  const metaVis = a.metadata?.visible;
  return memVis !== false && metaVis !== false;
}

// Server-side direct fetcher (the entry-point used by entity-catalog)

/**
 * Fetch agno's `/agents` + `/teams` + `/workflows` directly from the
 * credential's `restUrl` and project to the canonical EntityDescriptor.
 * Sub-failures degrade gracefully.
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
