/**
 * Centralised chat-path HTTP header names. See docs/orchestrator.md.
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
 * `uuid().defaultRandom()`. Use anywhere an untrusted string is
 * interpreted as a credential row id (X-Credential-Id header,
 * /api/entities credentialIds query param) so a giant hex string
 * can't reach the DB lookup.
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
