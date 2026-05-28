/**
 * Centralised chat-path HTTP header names.
 *
 * Why these are headers (not body fields):
 *   - They are routing metadata, not business data — same category as
 *     `Content-Type`, `Accept`, `X-Tenant-Id`.
 *   - They must be readable in `withSession`-style middleware before
 *     the body is parsed, so route handlers can fail-fast on a missing
 *     credential or unknown mode without consuming the request stream.
 *   - Putting them in the AG-UI `RunAgentInput` body would either
 *     pollute the AG-UI schema or require a `HttpAgent` subclass on
 *     the client to inject custom body fields.
 *
 * @see docs/orchestrator.md "Custom HTTP Headers" for the full rationale.
 */

/**
 * Identifies which admin-managed credential the user picked for a
 * backend agent dispatch. The single client-supplied identity field
 * on `/api/copilotkit/...`. Required on `agent/<id>/<run|connect|stop>`.
 *
 * Value contract: UUID v4 (36 chars, lowercase hex + hyphens). Validate
 * with {@link CREDENTIAL_ID_PATTERN} before trusting it.
 */
export const CREDENTIAL_ID_HEADER = "X-Credential-Id" as const;

/**
 * SECURITY: exact 36-char UUID v4 lock — credential rows are
 * `uuid().defaultRandom()`. Prevents arbitrarily long hex strings
 * from passing validation (DOS surface via giant ids on hot paths).
 *
 * Used to validate both the `X-Credential-Id` HTTP header value and
 * the `credentialIds` query parameter on `/api/entities` — anywhere
 * an untrusted string is interpreted as a credential row id before
 * the DB lookup.
 */
export const CREDENTIAL_ID_PATTERN: RegExp = /^[a-f0-9-]{36}$/;

/**
 * Carries the user's transient orchestration-mode preference
 * (`auto` / `tool-call` / `handoff` / `async`) on
 * `/api/copilotkit/builtin/...` requests. Only affects the supervisor
 * agent's system prompt directive. Optional — server falls back to
 * the registry default (`auto`) when missing or unrecognised.
 */
export const ORCHESTRATION_MODE_HEADER = "X-Orchestration-Mode" as const;
