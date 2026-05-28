/**
 * CopilotKit Runtime API route — backend-agnostic AG-UI chat channel.
 *
 * Inputs:
 *   - `agentId`  — parsed from URL path `/agent/<id>/<run|connect|stop>`
 *                  (CopilotKit's convention; matches `fetch-router.mjs`)
 *   - `credentialId` — from `X-Credential-Id` header (the one piece
 *                  of identity that cannot be server-derived; see
 *                  docs/orchestrator.md "Custom HTTP Headers")
 *   - `entityKind` — looked up server-side via `EntityCatalog`,
 *                  not trusted from the client
 *
 * See docs/orchestrator.md "Custom HTTP Headers" for the rationale
 * behind which fields are server-derived vs client-supplied.
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

/**
 * SECURITY: backend agent ids are developer-defined identifiers
 * (snake_case / kebab-case / camelCase, optional `.` for namespace
 * or version). Narrow alphabet rejects:
 *   - control chars / whitespace (header injection / CRLF / proxy mangling)
 *   - URL-boundary chars `? # & =` (id ends up in upstream path)
 *   - quoting / brackets (log unambiguity)
 *   - `:` `/` `@` `+` (these belong to modelId namespaces — Bedrock
 *     `:0` suffixes, HuggingFace `meta-llama/Llama-3`, npm
 *     `@scope/pkg` — used inside provider BridgeConfig, not here).
 *
 * 128-char ceiling is a DOS guard; real ids are well under 32.
 * Defence in depth: bridge-runtime-kit + chat handlers still URL-encode
 * the id when interpolating into upstream paths.
 */
const AGENT_ID_PATTERN: RegExp = /^[A-Za-z0-9._\-]{1,128}$/;

/** CopilotKit URL patterns that target a specific agent. Bookkeeping
 *  paths (`/info`, `/threads/*`, `/transcribe`) are stubbed (see
 *  BOOKKEEPING_PATH_PATTERN below) — Nango doesn't host remote
 *  agents/actions on this route, the BridgeAgent is registered
 *  client-side. @see CopilotKit `fetch-router.mjs`. */
const AGENT_PATH_PATTERN: RegExp = /\/agent\/([^/]+)\/(?:run|connect|stop)(?:\/[^/]+)?$/;

/**
 * CopilotKit client probes the runtime URL on init to discover
 * capabilities (`/info`), thread bookkeeping (`/threads/*`), and
 * audio transcription (`/transcribe`). Our backend chat route is a
 * hand-rolled REST→AG-UI bridge that doesn't host any of those —
 * the BridgeAgent is registered client-side, capabilities flow
 * through the agent instance, and we have no upstream audio path.
 *
 * Rather than 404 these (which makes the CopilotKit client log
 * `Failed to load runtime info` in the browser and emits two server
 * WARN lines per page mount), we respond with an empty descriptor.
 * The pattern also matches the bare base URL (`/api/copilotkit`)
 * which CopilotKit hits as part of its transport auto-detect probe.
 *
 * SECURITY: stubbing these is safe because the response is a static
 * literal — no DB or upstream call, no user data, no echoed input.
 */
const BOOKKEEPING_PATH_PATTERN: RegExp =
  /^\/api\/copilotkit\/?(?:info|threads(?:\/.*)?|transcribe)?$/;

const EMPTY_RUNTIME_INFO = { agents: [], actions: [] } as const;

const ROUTE = "/api/copilotkit/[...path]";

async function handler(req: NextRequest, userId: string, log: Logger): Promise<Response> {
  const pathname = new URL(req.url).pathname;

  // Bookkeeping endpoints — respond with an empty descriptor. No log
  // (these fire on every page mount; logging them would dominate the
  // chat route's signal). See BOOKKEEPING_PATH_PATTERN comment above.
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

  // SECURITY: strict guard — null on missing / disabled / wrong
  // serviceType / unregistered provider.
  const cfg = await getAgentCredentialConfigById(credentialId);
  if (!cfg) {
    log.warn(
      { event: "dispatch", outcome: "credential_not_found", agentId, credentialId },
      "credential not found, disabled, or not an agent backend",
    );
    throw new ApiError("NOT_FOUND", 404, "Credential not found or disabled.");
  }

  // Resolve entityKind from EntityCatalog (server-side authority).
  // Cache is warmed by WorkspaceProvider on UI mount; cold lookups
  // cost one backend `/info` round-trip per credential per 10 min.
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
