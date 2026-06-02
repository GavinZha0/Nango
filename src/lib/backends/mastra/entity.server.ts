/**
 * Mastra entity discovery — server-only. See docs/backend-integration.md.
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";
import type { EntityDescriptor } from "../types";

const log = childLogger({ component: "mastra-entity-fetcher" });

interface MastraToolDef {
  id?: string;
  description?: string;
  inputSchema?: string;
}

interface MastraAgentRaw {
  id: string;
  name?: string;
  description?: string;
  instructions?: string | Record<string, unknown>;
  tools?: Record<string, MastraToolDef>;
  provider?: string;
  modelId?: string;
  skills?: unknown[];
  [k: string]: unknown;
}

function projectMastraAgent(raw: MastraAgentRaw, credentialId: string): EntityDescriptor {
  const model = raw.modelId
    ? { id: raw.modelId, provider: raw.provider }
    : undefined;
  const toolCount =
    raw.tools && typeof raw.tools === "object" ? Object.keys(raw.tools).length : 0;
  const skillCount = Array.isArray(raw.skills) ? raw.skills.length : 0;
  const prompt = typeof raw.instructions === "string" ? raw.instructions : undefined;

  return {
    id: raw.id,
    kind: "agent",
    name: raw.name,
    description: raw.description,
    prompt,
    provider: "mastra",
    credentialId,
    model,
    toolCount,
    skillCount,
    kbCount: 0,
    raw: raw as Record<string, unknown>,
  };
}

export async function fetchMastraEntitiesServer(
  credentialId: string,
  baseUrl: string,
  token: string,
): Promise<EntityDescriptor[]> {
  try {
    const res = await fetch(`${baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      log.warn(
        { event: "mastra_list_failed", status: res.status, credentialId },
        "mastra /agents returned non-2xx",
      );
      return [];
    }
    const json = (await res.json()) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      log.warn(
        { event: "mastra_list_invalid", credentialId },
        "mastra /agents response is not the expected object map",
      );
      return [];
    }
    return Object.values(json as Record<string, MastraAgentRaw>).map((a) =>
      projectMastraAgent(a, credentialId),
    );
  } catch (err) {
    log.warn(
      {
        event: "mastra_list_failed",
        credentialId,
        err: err instanceof Error ? err.message : String(err),
      },
      "mastra /agents threw",
    );
    return [];
  }
}
