/**
 * Web-search integration layer — domain types and provider interface.
 *
 * Mirrors the data-source / SSH module shape: a small client-safe
 * type surface plus a server-only provider implementation per
 * upstream service. One credential per provider (via the existing
 * `credential` table, `serviceType = "search"`).
 */

/**
 * Providers wired into the `web_search` runtime tool. Adding a new
 * provider: append here + add a file under `src/lib/web-search/<id>/`
 * + register in `registry.server.ts` (the `satisfies` clause enforces
 * compile-time coverage).
 *
 * The `jina` id binds to Jina Search (`s.jina.ai`), not the Reader
 * (`r.jina.ai`) — the latter is a URL → Markdown extractor and does
 * not fit a query-driven search abstraction.
 */
export const WEB_SEARCH_PROVIDER_IDS = ["exa", "tavily", "brave", "jina"] as const;
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

export function isWebSearchProvider(value: string): value is WebSearchProviderId {
  return (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Normalised search hit. Every provider maps its native fields onto
 * this shape so the LLM sees a stable contract regardless of which
 * upstream answered. Optional fields are omitted (not nulled) when
 * the upstream did not return them — keeps the JSON terse.
 *
 * RATIONALE FOR `image` / `favicon`: Exa returns these natively in
 * `/search`; they make a huge UX difference once a chat-side renderer
 * picks them up. They're declared OPTIONAL on the shared type so
 * providers without an equivalent field (Tavily, Brave) simply omit
 * them, and a future client component can render a graceful fallback.
 */
export interface WebSearchResult {
  title: string;
  url: string;
  /** Text excerpt of the page. Capped per-provider (see SNIPPET_MAX_CHARS). */
  snippet: string;
  /** ISO-8601 publication / crawl date when the upstream provides it. */
  publishedAt?: string;
  /** Page hero / OG image URL when the upstream provides it. Renderers
   *  MUST treat broken-image events as "drop silently" — upstream OG
   *  tags are unreliable. */
  image?: string;
  /** Site favicon URL when the upstream provides it. Same broken-image
   *  policy as `image`. */
  favicon?: string;
}

/**
 * Per-provider authentication slice. Always the decrypted API key
 * plus the optional `restUrl` override stored on the credential row
 * (lets users point at a self-hosted / proxy endpoint without code
 * changes).
 */
export interface WebSearchAuth {
  apiKey: string;
  restUrl: string | null;
}

/**
 * Server-only provider contract. Each entry in
 * `WEB_SEARCH_PROVIDERS` implements this; the runtime tool resolves
 * the credential, then calls `search(...)` directly.
 *
 * CONTRACT:
 *   - Throws on upstream / network / parse failure. The runtime
 *     tool's outer wrapper turns those throws into the standard
 *     `{ ok: false, error, message }` envelope (see `tool-failure.ts`).
 *   - Honours `signal` for cancellation (the runtime sets a 10 s
 *     wall-clock timeout).
 *   - Returns ≤ `topK` results; may return fewer if the upstream had
 *     fewer matches.
 */
export interface WebSearchProvider {
  readonly id: WebSearchProviderId;
  /** Short label for logs and the tool result's `provider` field. */
  readonly displayName: string;
  search(
    args: { query: string; topK: number; signal: AbortSignal },
    auth: WebSearchAuth,
  ): Promise<WebSearchResult[]>;
}
