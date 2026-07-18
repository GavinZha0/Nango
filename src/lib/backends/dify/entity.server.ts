/**
 * Dify entity discovery — server-only. See docs/backend-integration.md.
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";
import { describeFetchStatus } from "../types";
import type { EntityFetchResult } from "../types";

const log = childLogger({ component: "dify-entity-fetcher" });

/** Stable synthetic agent id — one per credential. */
const DIFY_AGENT_ID = "default";

interface DifyAppInfo {
  name?: string;
  description?: string;
  tags?: string[];
}

export async function fetchDifyEntitiesServer(
  credentialId: string,
  baseUrl: string,
  token: string,
): Promise<EntityFetchResult> {
  try {
    const res = await fetch(`${baseUrl}/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      log.warn(
        { event: "dify_info_failed", status: res.status, credentialId },
        "dify /info returned non-2xx",
      );
      // Still surface the app under a placeholder name — the credential
      // is configured, so the user must be able to open settings to fix it.
      return {
          entities: [],
          errors: [{source: "/info", status: res.status, message: describeFetchStatus(res.status)}]
        };
    }
    const info = (await res.json()) as DifyAppInfo;
    return {
      entities: [
      {
        id: DIFY_AGENT_ID,
        kind: "agent",
        name: info.name ?? "Dify App",
        description: info.description,
        provider: "dify",
        credentialId,
      },
    ], 
    errors: []
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      {
        event: "dify_info_failed",
        credentialId,
        err: message,
      },
      "dify /info threw",
    );
    return {
      entities: [],
      errors: [{source: "/info", message: `Unreachable: ${message}`}]
    };
  }
}
