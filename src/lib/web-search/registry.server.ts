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
import { searxngProvider } from "./searxng.server";

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
  searxng: searxngProvider,
} as const satisfies Record<WebSearchProviderId, WebSearchProvider>;

/**
 * Tie-breaker order when more than one search credential is enabled.
 * Local SearXNG wins (no per-call cost, no query leaves the operator's
 * infrastructure), then Jina (free tier, no per-call charge), then the
 * paid providers. Within a provider id, the most recently created
 * credential wins (handled in `lookup.server.ts`).
 *
 * Operators who want a paid provider to win while a SearXNG credential
 * is still enabled must disable the SearXNG credential — selection is
 * global, not per-agent.
 */
export const PROVIDER_PRIORITY: readonly WebSearchProviderId[] = [
  "searxng",
  "jina",
  "exa",
  "tavily",
  "brave",
];

export function getWebSearchProvider(id: WebSearchProviderId): WebSearchProvider {
  return WEB_SEARCH_PROVIDERS[id];
}
