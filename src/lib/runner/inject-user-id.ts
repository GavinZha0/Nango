/**
 * Inject server-trusted user_id into chat-path AG-UI request bodies.
 */

import "server-only";

/**
 * Overwrite (or add) `forwardedProps.user_id` on a CopilotKit AG-UI
 * `/run` POST request with a server-trusted value.
 *
 * Why: AG-UI bridge agents (agno, Mastra, Dify) read `user_id` from
 * `RunAgentInput.forwardedProps` to scope memory / session / threads
 * on the external backend. Without this helper that value comes from
 * the browser's `<CopilotKitProvider properties={...}>` — i.e.
 * client-supplied and spoofable via devtools. Programmatic dispatches
 * (`runner.start`) already pass `forwardedProps: { user_id: ownerId }`
 * built from server-side state (`StartRunInput.ownerId`); this helper
 * brings chat dispatches to the same trust level so every
 * `forwardedProps.user_id` reaching a bridge agent is server-trusted.
 *
 * Contract: `userId` must be the value resolved from the session
 * (`withSession` → `session.user.id`), not anything derived from the
 * request body. Bridges trust this field unconditionally; there is no
 * tertiary defence layer below this point.
 *
 * Guard: only POST `/agent/<id>/run` carries `forwardedProps`. Other
 * verbs and other CopilotKit routes (`/connect`, `/info`, `/threads/*`,
 * `/transcribe`, etc.) pass through unmodified so we don't pointlessly
 * re-serialise bookkeeping requests.
 *
 * @see docs/orchestrator.md "CopilotKit's Role: Protocol Adapter,
 *      Not Dispatch Engine"
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
