/**
 * Backend REST API reverse proxy.
 */

import { NextRequest } from "next/server";
import { getAgentCredentialConfigById } from "@/lib/credentials/lookup";
import { CREDENTIAL_ID_HEADER, CREDENTIAL_ID_PATTERN } from "@/lib/http/chat-headers";
import { ApiError, withSession } from "@/lib/http/route-handlers";

export const dynamic = "force-dynamic";

const ROUTE = "/api/backend/[...path]";

/** Abort upstream requests that take longer than this (ms). */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Request headers forwarded to the upstream backend. */
const FORWARDED_HEADER_NAMES: readonly string[] = [
  "accept",
  "content-type",
  "content-length",
  "user-agent",
  "x-request-id",
  "x-correlation-id",
];

/** Response headers forwarded back to the browser.
 *  Everything else (Server, X-Powered-By, internal IPs, …) is stripped. */
const ALLOWED_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "cache-control",
  "etag",
  "last-modified",
  "vary",
  "x-request-id",
  "x-correlation-id",
];

function buildForwardHeaders(requestHeaders: Headers): Headers {
  const forwardHeaders = new Headers();
  FORWARDED_HEADER_NAMES.forEach((headerName: string): void => {
    const headerValue: string | null = requestHeaders.get(headerName);
    if (headerValue !== null) {
      forwardHeaders.set(headerName, headerValue);
    }
  });
  return forwardHeaders;
}

async function proxy(
  request: NextRequest,
  args: {
    params: { path: string[] };
    userId: string;
  }
): Promise<Response> {
  const { path } = args.params;

  // Resolve which backend to forward to via X-Credential-Id header.
  const credentialId = request.headers.get(CREDENTIAL_ID_HEADER);
  if (!credentialId) {
    throw new ApiError("BAD_REQUEST", 400, `${CREDENTIAL_ID_HEADER} header is required`);
  }
  if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
    throw new ApiError("BAD_REQUEST", 400, `${CREDENTIAL_ID_HEADER} contains invalid characters`);
  }

  const cfg = await getAgentCredentialConfigById(credentialId);
  if (!cfg) {
    throw new ApiError("NOT_FOUND", 404, "Credential not found or disabled.");
  }

  const effectiveRestUrl = (cfg.restUrl ?? "").replace(/\/$/, "");
  if (!effectiveRestUrl) {
    throw new ApiError("SERVICE_UNAVAILABLE", 503, "REST URL is not configured on this credential.");
  }

  if (!cfg.token) {
    throw new ApiError("SERVICE_UNAVAILABLE", 503, "Auth token is not configured on this credential.");
  }

  // Forward a strict allowlist only.
  const forwardHeaders = buildForwardHeaders(request.headers);
  forwardHeaders.set("Authorization", `Bearer ${cfg.token}`);

  const targetUrl = `${effectiveRestUrl}/${path.join("/")}${request.nextUrl.search}`;

  // Inject the authenticated user's identity server-side.
  // Use the stable user UUID rather than the email local-part: emails can
  // change and different users may share the same local-part across domains.
  forwardHeaders.set("X-User-ID", args.userId);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body:
        request.method !== "GET" && request.method !== "HEAD"
          ? request.body
          : null,
      // Required for streaming request bodies in Node.js fetch.
      // @ts-expect-error — 'duplex' is valid in Node 18+ but not yet in TS types
      duplex: "half",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    throw new ApiError(
      "BAD_GATEWAY",
      504,
      isTimeout
        ? `Backend at ${effectiveRestUrl} did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s.`
        : `Cannot reach backend at ${effectiveRestUrl}.`,
      { detail: message },
    );
  }

  // Only forward safe response headers.
  const downstreamHeaders = new Headers();
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value !== null) downstreamHeaders.set(name, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: downstreamHeaders,
  });
}

export const GET = withSession<{ path: string[] }>(ROUTE, async ({ req, params, session }) => {
  return proxy(req, { params, userId: session.user.id });
});

export const POST = withSession<{ path: string[] }>(ROUTE, async ({ req, params, session }) => {
  return proxy(req, { params, userId: session.user.id });
});

export const PUT = withSession<{ path: string[] }>(ROUTE, async ({ req, params, session }) => {
  return proxy(req, { params, userId: session.user.id });
});

export const PATCH = withSession<{ path: string[] }>(ROUTE, async ({ req, params, session }) => {
  return proxy(req, { params, userId: session.user.id });
});

export const DELETE = withSession<{ path: string[] }>(ROUTE, async ({ req, params, session }) => {
  return proxy(req, { params, userId: session.user.id });
});
