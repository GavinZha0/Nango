/**
 * CopilotKit Runtime API route — backend-agnostic AG-UI chat channel.
 * `agentId` comes from the URL path, `credentialId` from the header,
 * `entityKind` is server-resolved via `EntityCatalog`. See
 * docs/orchestrator.md.
 */

import { NextRequest } from "next/server";
import type { Logger } from "pino";

import { Observable } from "rxjs";

import type { AbstractAgent, BaseEvent } from "@/lib/copilot/index.server";
import { AbstractAgent as BaseAbstractAgent } from "@/lib/copilot/index.server";
import { getAgentCredentialConfigById } from "@/lib/credentials/lookup";

class BackendStubAgent extends BaseAbstractAgent {
  run() {
    return new Observable<BaseEvent>((s) => s.complete());
  }
}

import { EntityCatalog } from "@/lib/backends/entity-catalog";
import { runWithAgents } from "@/lib/backends/runtime.server";
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

/** CopilotKit bookkeeping probes that don't need an agent map:
 *  /threads/* (thread management) and /transcribe (speech). These
 *  return an empty runtime descriptor — the browser doesn't consult
 *  the agent list from these endpoints. */
const EMPTY_BOOKKEEPING_PATTERN: RegExp =
  /^\/api\/copilotkit\/?(?:threads(?:\/.*)?|transcribe)?$/;

/** CopilotKit `/info` probe — runtime sync. CopilotKit's `useAgent`
 *  hook depends on `/info` returning the registered agent list so
 *  the client-side clone can be created. Handled separately from
 *  the empty-bookkeeping paths above because `/info` needs a real
 *  agent map built from `EntityCatalog`. */
const INFO_PATH_PATTERN: RegExp = /^\/api\/copilotkit\/?info$/;

const EMPTY_RUNTIME_INFO = { agents: [], actions: [] } as const;

const ROUTE = "/api/copilotkit/[...path]";

/**
 * Parse and validate the `X-Credential-Id` header. Returns the
 * validated credentialId or null when the header is absent / invalid.
 * Logs on invalid format only — absence is normal for bookkeeping.
 */
function resolveCredentialIdHeader(
  req: NextRequest,
  log: Logger,
): string | null {
  const raw = req.headers.get(CREDENTIAL_ID_HEADER);
  if (!raw) return null;
  if (!CREDENTIAL_ID_PATTERN.test(raw)) {
    log.warn(
      { event: "validation", outcome: "invalid_credential_id" },
      `${CREDENTIAL_ID_HEADER} invalid`,
    );
    return null;
  }
  return raw;
}

/**
 * Build stub agents from EntityCatalog for the `/info` fast path.
 * CopilotKit's `useAgent` hook requires `/info` to return the
 * registered agent IDs; entity data is already cached in-process
 * (10-min TTL, warmed by the agent picker on UI mount), so this
 * is a near-zero-cost synchronous Map lookup in practice.
 */
async function handleInfoRequest(
  req: NextRequest,
  credentialId: string | null,
): Promise<Response> {
  if (!credentialId) {
    return Response.json(EMPTY_RUNTIME_INFO);
  }

  const entities = await EntityCatalog.list(credentialId);
  if (!entities || entities.length === 0) {
    return Response.json(EMPTY_RUNTIME_INFO);
  }

  const stubAgents: Record<string, AbstractAgent> = {};
  for (const entity of entities) {
    stubAgents[entity.id] = new BackendStubAgent();
  }

  return runWithAgents(req, {
    agents: stubAgents,
    endpoint: "/api/copilotkit",
    trimMessages: false,
    entitySource: "backend",
  });
}

async function handler(req: NextRequest, userId: string, log: Logger): Promise<Response> {
  const pathname = new URL(req.url).pathname;

  // /threads/*, /transcribe — no agent map needed.
  if (EMPTY_BOOKKEEPING_PATTERN.test(pathname)) {
    return Response.json(EMPTY_RUNTIME_INFO);
  }

  // /info — build stub agents from EntityCatalog so CopilotKit's
  // `useAgent` can resolve the active agentId after runtime sync.
  if (INFO_PATH_PATTERN.test(pathname)) {
    const credentialId = resolveCredentialIdHeader(req, log);
    return handleInfoRequest(req, credentialId);
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
