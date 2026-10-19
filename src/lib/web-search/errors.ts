/**
 * Shared typed errors thrown by web-search providers. The runtime
 * tool catches these and maps them to `{ ok: false, error, message }`
 * envelopes — no instanceof inspection happens outside this module.
 */

import type { WebSearchProviderId } from "./types";

/**
 * Thrown by any provider when the upstream HTTP call returns a
 * non-2xx response. The runtime tool catches this generically and
 * renders `error: "UPSTREAM_HTTP"` with the provider name + status
 * in the user-facing message, so adding a new provider doesn't
 * need a new error class or a new `instanceof` branch.
 *
 * `body` is a clipped excerpt (~500 chars) of the response body —
 * surfaced in pino logs for admin debugging but kept out of the
 * LLM-facing message to avoid leaking upstream error formats into
 * the conversation.
 *
 * `hint` is an optional, provider-authored remediation sentence that
 * the runtime appends to the LLM-facing message (e.g. "enable JSON in
 * SearXNG's search.formats"). Keep it free of response-body content.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: WebSearchProviderId,
    readonly status: number,
    readonly body: string,
    readonly hint?: string,
  ) {
    super(`${provider} upstream HTTP ${status}: ${body}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * Thrown when the upstream could not be reached at all — DNS failure,
 * connection refused, TLS error. Distinct from {@link ProviderHttpError}
 * (server answered with non-2xx) and from INVALID_RESPONSE (server
 * answered but the body was unusable), so the LLM and the admin see the
 * right remediation.
 *
 * `detail` is the underlying cause (`getaddrinfo ENOTFOUND …`,
 * `connect ECONNREFUSED …`). `hint` is provider-authored deployment
 * guidance, e.g. host vs Docker service name.
 */
export class ProviderNetworkError extends Error {
  constructor(
    readonly provider: WebSearchProviderId,
    readonly url: string,
    readonly detail: string,
    readonly hint?: string,
  ) {
    super(
      `Could not reach ${provider} at ${url}. ` +
        "Check that the credential's Base URL is reachable from the Nango server." +
        (hint ? ` ${hint}` : "") +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "ProviderNetworkError";
  }
}

/**
 * True for fetch/AbortSignal cancellation errors in both DOM (browser
 * / older Node) and Error (undici) shapes. Kept here so the runtime tool
 * and every provider classify cancellation identically.
 */
export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

/**
 * Reserved for providers registered in the catalog but not yet wired
 * to their upstream API. No provider currently throws this — every
 * shipping provider (Exa, Tavily, Brave, Jina, SearXNG) is implemented
 * — but the class stays exported so a future stub addition does not
 * need to re-introduce the runtime-tool `error: "NOT_IMPLEMENTED"`
 * branch from scratch.
 */
export class NotImplementedError extends Error {
  constructor(readonly provider: WebSearchProviderId) {
    super(`web_search provider "${provider}" is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
