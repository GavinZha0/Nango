/**
 * Server-only web-search provider registry.
 *
 * Mirrors `src/lib/data-sources/registry.server.ts` — the `satisfies`
 * clause forces every `WebSearchProviderId` to have a runtime
 * implementation, so adding an id without a provider file becomes a
 * compile error.
 */

import "server-only";

import type { WebSearchProvider, WebSearchProviderId } from "./types";

import { exaProvider } from "./exa.server";
import { tavilyProvider } from "./tavily.server";
import { braveProvider } from "./brave.server";
import { jinaProvider } from "./jina.server";

/**
 * Active provider map. Order is irrelevant here — selection priority
 * lives in {@link PROVIDER_PRIORITY} below so the "which provider
 * wins when multiple credentials are enabled" question has one
 * answer the runtime, the tests and the docs can all point at.
 */
export const WEB_SEARCH_PROVIDERS = {
  exa: exaProvider,
  tavily: tavilyProvider,
  brave: braveProvider,
  jina: jinaProvider,
} as const satisfies Record<WebSearchProviderId, WebSearchProvider>;

/**
 * Tie-breaker order when more than one search credential is enabled.
 * Paid providers come first (Exa with summary, Tavily, Brave with
 * thumbnails); Jina lands at the tail as the free-tier fallback —
 * cheaper but slower and visually plainer. Within a provider id,
 * the most recently created credential wins (handled in
 * `lookup.server.ts`).
 */
export const PROVIDER_PRIORITY: readonly WebSearchProviderId[] = [
  "exa",
  "tavily",
  "brave",
  "jina",
];

export function getWebSearchProvider(id: WebSearchProviderId): WebSearchProvider {
  return WEB_SEARCH_PROVIDERS[id];
}
