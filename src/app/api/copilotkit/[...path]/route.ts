/**
 * CopilotKit Runtime API route — backend-agnostic AG-UI chat channel.
 * `agentId` comes from the URL path, `credentialId` from the header,
 * `entityKind` is server-resolved via `EntityCatalog`. See
 * docs/orchestrator.md.
 */

import { NextRequest } from "next/server";
import type { Logger } from "pino";

import { getAgentCredentialConfigById } from "@/lib/credentials/lookup";
import { EntityCatalog } from "@/lib/backends/entity-catalog";
import { CREDENTIAL_ID_HEADER, CREDENTIAL_ID_PATTERN } from "@/lib/http/chat-headers";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import { runner } from "@/lib/runner";
import type { EntityKind } from "@/lib/backends/types";

export const dynamic = "force-dynamic";

type RouteParams = { path: string[] };

/** SECURITY: narrow alphabet for backend agent ids — rejects
 *  control chars, URL-boundary chars (`?`, `#`, `&`, `=`), and the
 *  `:` `/` `@` `+` belonging to modelId namespaces. 128-char ceiling
 *  is a DOS guard. */
const AGENT_ID_PATTERN: RegExp = /^[A-Za-z0-9._\-]{1,128}$/;

/** CopilotKit per-agent URLs (see `fetch-router.mjs`). */
const AGENT_PATH_PATTERN: RegExp = /\/agent\/([^/]+)\/(?:run|connect|stop)(?:\/[^/]+)?$/;

/** CopilotKit bookkeeping probes (/info, /threads/*, /transcribe).
 *  We don't host remote agents/actions here — the BridgeAgent is
 *  client-side. Stubbed with an empty descriptor so the browser
 *  doesn't log "Failed to load runtime info" on every page mount. */
const BOOKKEEPING_PATH_PATTERN: RegExp =
  /^\/api\/copilotkit\/?(?:info|threads(?:\/.*)?|transcribe)?$/;

const EMPTY_RUNTIME_INFO = { agents: [], actions: [] } as const;

const ROUTE = "/api/copilotkit/[...path]";

async function handler(req: NextRequest, userId: string, log: Logger): Promise<Response> {
  const pathname = new URL(req.url).pathname;

  // No log — these fire on every page mount.
  if (BOOKKEEPING_PATH_PATTERN.test(pathname)) {
    return Response.json(EMPTY_RUNTIME_INFO);
  }

  const pathMatch = AGENT_PATH_PATTERN.exec(pathname);
  if (!pathMatch) {
    log.warn(
      { event: "validation", outcome: "unsupported_path", path: pathname },
      "path not supported on backend chat route",
    );
    throw new ApiError(
      "NOT_FOUND",
      404,
      "Path not supported. Backend chat route serves /agent/<id>/<run|connect|stop> only.",
    );
  }
  const agentId = pathMatch[1];
  if (!AGENT_ID_PATTERN.test(agentId)) {
    log.warn({ event: "validation", outcome: "invalid_agent_id", agentId }, "agentId invalid");
    throw new ApiError("BAD_REQUEST", 400, "agentId in URL contains invalid characters");
  }

  const credentialId = req.headers.get(CREDENTIAL_ID_HEADER);
  if (!credentialId) {
    log.warn({ event: "validation", outcome: "missing_credential_id", agentId }, `${CREDENTIAL_ID_HEADER} missing`);
    throw new ApiError("BAD_REQUEST", 400, `${CREDENTIAL_ID_HEADER} header is required`);
  }
  if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
    log.warn({ event: "validation", outcome: "invalid_credential_id", agentId }, `${CREDENTIAL_ID_HEADER} invalid`);
    throw new ApiError("BAD_REQUEST", 400, `${CREDENTIAL_ID_HEADER} contains invalid characters`);
  }

  // SECURITY: strict — null on missing / disabled / wrong type.
  const cfg = await getAgentCredentialConfigById(credentialId);
  if (!cfg) {
    log.warn(
      { event: "dispatch", outcome: "credential_not_found", agentId, credentialId },
      "credential not found, disabled, or not an agent backend",
    );
    throw new ApiError("NOT_FOUND", 404, "Credential not found or disabled.");
  }

  // entityKind from server-side EntityCatalog (cached 10 min).
  const entities = await EntityCatalog.list(credentialId);
  const entity = entities?.find((e) => e.id === agentId);
  if (!entity) {
    log.warn(
      { event: "dispatch", outcome: "entity_not_in_catalog", agentId, credentialId },
      "agent not found in this credential's entity catalog",
    );
    throw new ApiError(
      "NOT_FOUND",
      404,
      `Agent '${agentId}' not found in credential.`,
    );
  }
  const entityKind: EntityKind = entity.kind;

  return runner.runChatRequest(req, {
    entityId: agentId,
    credentialId,
    entityKind,
    task: "", // populated from messages by the bridge agent itself
    mode: "sync",
    initiator: "user",
    ownerId: userId,
    createdBy: userId,
  });
}

export const GET = withSession<RouteParams>(ROUTE, async ({ req, session, log }) => {
  return handler(req, session.user.id, log);
});

export const POST = withSession<RouteParams>(ROUTE, async ({ req, session, log }) => {
  return handler(req, session.user.id, log);
});
