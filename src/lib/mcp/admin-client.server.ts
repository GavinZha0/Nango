/**
 * Admin-side MCP client helper.
 */

import "server-only";

import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { db } from "@/lib/db";
import { McpServerTable, type McpServerEntity } from "@/lib/db/schema";
import { getCredentialFieldsById } from "@/lib/credentials/lookup";
import { getOAuthAccessToken } from "@/lib/credentials/oauth-token-manager";
import { logger } from "@/lib/observability/logger";
import { ApiError } from "@/lib/http/route-handlers";

/**
 * Build the outbound HTTP header map for an MCP server connection.
 *
 * Combines the row's free-form `headers` (typically used for tracing /
 * vendor-specific tags) with a credential-derived auth header when
 * `credentialId` is set.
 *
 * Header NAME is configurable (`server.credentialHeader`, default
 * `Authorization`). Header VALUE depends on credential type:
 *
 *   - `oauth_client`  → `Bearer <access_token>`, where the access
 *                       token is fetched via {@link getOAuthAccessToken}
 *                       (cached + auto-refreshed; see
 *                       `lib/credentials/oauth-token-manager.ts`).
 *   - everything else → legacy extractor (`payload.token ?? key ??
 *                       password`); for `Authorization` we prepend
 *                       `Bearer `, other header names get the raw
 *                       token (matches the most common MCP-server
 *                       convention).
 *
 * If token resolution fails (e.g. OAuth IdP unreachable, credential
 * disabled), we log the failure but still return a header map
 * **without** the auth header — the downstream MCP call will then
 * surface a 401 with a clearer "no auth was sent" signal rather than
 * the whole transport blowing up. The error stack is captured in the
 * logs for ops.
 *
 * Exported so admin endpoints that don't need a full MCP client
 * round-trip (e.g. a future "show me the headers we'd send" debug
 * endpoint) can reuse the auth logic without going through
 * `withMcpAdminClient`.
 */
export async function buildMcpHeaders(
  server: Pick<
    McpServerEntity,
    "headers" | "credentialId" | "credentialHeader"
  >,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(server.headers ?? {}) };
  if (!server.credentialId) return headers;

  const headerName: string = server.credentialHeader ?? "Authorization";
  const isAuthorization: boolean = headerName.toLowerCase() === "authorization";

  const cred = await getCredentialFieldsById(server.credentialId);
  if (cred === null) return headers;

  if (cred.type === "oauth_client") {
    try {
      const accessToken: string = await getOAuthAccessToken(server.credentialId);
      headers[headerName] = isAuthorization
        ? `Bearer ${accessToken}`
        : accessToken;
    } catch (err) {
      logger.error(
        {
          component: "mcp-admin-client",
          event: "oauth_token_failed",
          credentialId: server.credentialId,
          err: err instanceof Error ? { message: err.message, name: err.name } : String(err),
        },
        "Failed to obtain OAuth access token for MCP server; request will be sent without auth header",
      );
    }
    return headers;
  }

  // Legacy single-field types (api_key, bearer_token, basic_auth's
  // password slot, etc.). Mirror the extraction order from
  // `getCredentialTokenById`.
  const raw: unknown =
    cred.fields.token ?? cred.fields.key ?? cred.fields.password;
  if (typeof raw === "string" && raw.length > 0) {
    headers[headerName] = isAuthorization ? `Bearer ${raw}` : raw;
  }
  return headers;
}

/**
 * Run `fn` against a connected MCP client for the row identified
 * by `serverId`. Sets up the transport (SSE vs streamable-HTTP per
 * `server.type`), wires auth headers, and ensures `client.close()`
 * runs on every exit path.
 *
 * Error mapping:
 *   - Server row missing → `ApiError(NOT_FOUND, 404)`
 *   - `fn` throws an `ApiError` → propagated as-is (caller's
 *     deliberate domain error, e.g. a future `VALIDATION_FAILED`)
 *   - Anything else (transport / SDK) → wrapped as
 *     `ApiError(BAD_GATEWAY, 502, "<errorPrefix>: <message>")`
 *
 * @param errorPrefix human-readable label injected into the 502
 *   message so the caller sees "Failed to discover tools: …" vs
 *   "Tool call failed: …" without each route hand-rolling its
 *   own try/catch.
 */
export async function withMcpAdminClient<T>(opts: {
  serverId: string;
  clientName: string;
  errorPrefix: string;
  fn: (ctx: { client: Client; server: McpServerEntity }) => Promise<T>;
}): Promise<T> {
  // Fetch the server row first — no point opening any sockets when
  // the id is bogus. NOT_FOUND must precede any transport work so
  // the error envelope is precise.
  const [server] = await db
    .select()
    .from(McpServerTable)
    .where(eq(McpServerTable.id, opts.serverId));
  if (!server) {
    throw new ApiError("NOT_FOUND", 404, "Server not found.");
  }

  const headers = await buildMcpHeaders(server);
  const transport = server.type === "sse"
    ? new SSEClientTransport(new URL(server.url), { requestInit: { headers } })
    : new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers },
      });

  let client: Client | null = null;
  try {
    client = new Client({ name: opts.clientName, version: "1.0.0" });
    await client.connect(transport);
    return await opts.fn({ client, server });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError("BAD_GATEWAY", 502, `${opts.errorPrefix}: ${message}`);
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore close errors — connection may have already failed */
      }
    }
  }
}
