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
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: WebSearchProviderId,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${provider} upstream HTTP ${status}: ${body}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * Reserved for providers registered in the catalog but not yet wired
 * to their upstream API. No provider currently throws this — all
 * four shipping providers (Exa, Tavily, Brave, Jina) are implemented
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
