/**
 * Inject server-trusted user_id into chat-path AG-UI request bodies.
 */

import "server-only";

/**
 * Overwrite (or add) `forwardedProps.user_id` on a CopilotKit AG-UI
 * `/run` POST body with a server-trusted value. Bridges (agno, Mastra,
 * Dify) trust `user_id` unconditionally for memory / session scoping;
 * without this helper it would come from the browser provider.
 *
 * CONTRACT: `userId` MUST be resolved from the session, not from the
 * request body. Only POST `/agent/<id>/run` is rewritten; other verbs
 * and CopilotKit routes pass through unchanged.
 *
 * See docs/orchestrator.md.
 */
export async function injectServerUserId(
  request: Request,
  userId: string,
): Promise<Request> {
  if (request.method !== "POST") return request;
  if (!/\/agent\/[^/]+\/run\b/.test(new URL(request.url).pathname)) {
    return request;
  }

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return request;
  }
  if (!body || typeof body !== "object") return request;

  const original = body as { forwardedProps?: Record<string, unknown> };
  const next: Record<string, unknown> = {
    ...(body as Record<string, unknown>),
    forwardedProps: {
      ...(original.forwardedProps ?? {}),
      user_id: userId,
    },
  };

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(next),
  });
}
