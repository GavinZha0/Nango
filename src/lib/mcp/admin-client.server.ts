/**
 * Admin-side MCP client helper.
 *
 * See docs/builtin-runtime.md.
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
 * Outbound header map for an MCP server connection. Header NAME is
 * `server.credentialHeader` (default `Authorization`); VALUE is
 * `Bearer <access_token>` for `oauth_client` credentials (cached,
 * auto-refreshed) or `payload.token ?? key ?? password` otherwise.
 * Token-resolution failures log and return the headers WITHOUT auth
 * so the downstream MCP call surfaces a clean 401.
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
