/**
 * A2A entity discovery — server-only. See docs/a2a-compatibility.md.
 */

import "server-only";

import { getConfigMs } from "@/lib/config";
import { childLogger } from "@/lib/observability/logger";
import {
  BACKEND_ENTITY_FETCH_TIMEOUT_MS,
  type EntityDescriptor,
  type EntityFetchError,
  type EntityFetchOptions,
  type EntityFetchResult,
} from "../types";
import {
  createA2AFetch,
  fetchAgentCard,
  resolveA2AEndpointUrl,
} from "./client.server";

const log = childLogger({ component: "a2a-entity-fetcher" });

const DEFAULT_A2A_AGENT_ID = "default";
const MAX_CONCURRENT_CARD_FETCHES = 5;

function formatFetchError(err: unknown, timeoutMs: number): string {
  const isTimeout =
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError");
  if (isTimeout) {
    return `Connection timed out (${Math.round(timeoutMs / 1000)}s)`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function fetchSingleAgentDescriptor(
  credentialId: string,
  agentId: string,
  endpointUrl: string,
  fetchImpl: typeof fetch,
  fallbackName: string,
): Promise<EntityDescriptor> {
  const card = await fetchAgentCard(endpointUrl, fetchImpl);
  return {
    id: agentId,
    kind: "agent",
    name: card.name?.trim() || fallbackName,
    description: card.description?.trim() || undefined,
    version: card.version?.trim() || undefined,
    skillCount: Array.isArray(card.skills) ? card.skills.length : undefined,
    provider: "a2a",
    credentialId,
  };
}

export async function fetchA2AEntitiesServer(
  credentialId: string,
  restUrl: string,
  token: string,
  options?: EntityFetchOptions,
): Promise<EntityFetchResult> {
  const timeoutMs = getConfigMs(
    "backend.entity_fetch.timeout",
    BACKEND_ENTITY_FETCH_TIMEOUT_MS / 1000,
  );
  const fetchImpl = createA2AFetch(
    token,
    options?.type,
    options?.headerName,
    timeoutMs,
  );

  const configuredIds = (options?.metadata?.agentIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);

  // Single-agent mode when no agentIds are configured.
  if (configuredIds.length === 0) {
    const endpointUrl = resolveA2AEndpointUrl(restUrl);
    try {
      const entity = await fetchSingleAgentDescriptor(
        credentialId,
        DEFAULT_A2A_AGENT_ID,
        endpointUrl,
        fetchImpl,
        "A2A Agent",
      );
      return { entities: [entity], errors: [] };
    } catch (err) {
      const message = formatFetchError(err, timeoutMs);
      log.warn(
        { event: "a2a_card_fetch_failed", credentialId, endpointUrl, err: message },
        "failed to fetch A2A agent card",
      );
      return {
        entities: [],
        errors: [{ source: endpointUrl, message: `Unreachable: ${message}` }],
      };
    }
  }

  // Multi-agent mode: fetch cards in bounded batches with per-agent fault isolation.
  const entities: EntityDescriptor[] = [];
  const errors: EntityFetchError[] = [];

  for (let i = 0; i < configuredIds.length; i += MAX_CONCURRENT_CARD_FETCHES) {
    const batch = configuredIds.slice(i, i + MAX_CONCURRENT_CARD_FETCHES);
    const results = await Promise.allSettled(
      batch.map(async (agentId) => {
        const endpointUrl = resolveA2AEndpointUrl(restUrl, agentId);
        return fetchSingleAgentDescriptor(
          credentialId,
          agentId,
          endpointUrl,
          fetchImpl,
          agentId,
        );
      }),
    );

    results.forEach((result, idx) => {
      const agentId = batch[idx];
      if (result.status === "fulfilled") {
        entities.push(result.value);
      } else {
        const message = formatFetchError(result.reason, timeoutMs);
        log.warn(
          { event: "a2a_card_fetch_failed", credentialId, agentId, err: message },
          "failed to fetch A2A agent card for configured agentId",
        );
        errors.push({
          source: agentId,
          message: `${agentId}: ${message}`,
        });
      }
    });
  }

  return { entities, errors };
}
