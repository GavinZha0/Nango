/**
 * Dify entity discovery — server-only.
 *
 * @see docs/backend-integration.md#11-provider-specific-quirks-and-mappings
 */

import "server-only";

import { childLogger } from "@/lib/observability/logger";
import type { EntityDescriptor } from "../types";

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
): Promise<EntityDescriptor[]> {
  try {
    const res = await fetch(`${baseUrl}/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      log.warn(
        { event: "dify_info_failed", status: res.status, credentialId },
        "dify /info returned non-2xx",
      );
      // Even if /info fails we still surface the app — the user knows it
      // exists (the credential is configured), they just don't get the
      // app name. Keep displaying it with a placeholder so the user can
      // open settings to fix.
      return [
        {
          id: DIFY_AGENT_ID,
          kind: "agent",
          name: "Dify App",
          provider: "dify",
          credentialId,
        },
      ];
    }
    const info = (await res.json()) as DifyAppInfo;
    return [
      {
        id: DIFY_AGENT_ID,
        kind: "agent",
        name: info.name ?? "Dify App",
        description: info.description,
        provider: "dify",
        credentialId,
      },
    ];
  } catch (err) {
    log.warn(
      {
        event: "dify_info_failed",
        credentialId,
        err: err instanceof Error ? err.message : String(err),
      },
      "dify /info threw",
    );
    return [];
  }
}
