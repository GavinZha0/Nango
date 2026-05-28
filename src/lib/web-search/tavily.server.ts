/**
 * Tavily search provider (https://tavily.com).
 *
 * Endpoint:   POST {restUrl ?? "https://api.tavily.com"}/search
 * Auth:       Authorization: Bearer <apiKey>  (modern; preferred)
 *             — Tavily also accepts `api_key` in the JSON body for
 *             backward compat, but the Bearer header is what their
 *             docs recommend in 2025+.
 * Request:    {
 *               query, max_results,
 *               search_depth: "basic",
 *               include_favicon: true,
 *               include_answer: false,
 *             }
 * Response:   { results: [{ title, url, content, published_date?, favicon? }] }
 *
 * Tavily's `content` field is the "most query-relevant excerpt"
 * from the source page — conceptually equivalent to what we expose
 * as `snippet` everywhere else in the WebSearchResult contract.
 * It's not labelled as a "summary" by Tavily, but in practice the
 * output is comparable in length and focus to Exa's `summary`
 * (typically 1-3 sentences).
 *
 * KNOWN DIFFERENCES from Exa:
 *   - Tavily does NOT return per-result OG / hero images. Their
 *     `include_images` flag returns a top-level `images: string[]`
 *     array that isn't attached to individual results, which our
 *     card_list UI cannot consume. We do not request it.
 *   - `published_date` only appears when `topic: "news"` (we use
 *     the default "general"); for general queries `publishedAt`
 *     will be undefined on every result.
 *   - `include_favicon: true` gives us a per-result `favicon`
 *     URL — used in the card thumbnail slot when image is absent,
 *     fully consistent with the WebSearchResult contract.
 */

import "server-only";

import { getConfig, getConfigNumber } from "@/lib/config";

import { ProviderHttpError } from "./errors";
import type {
  WebSearchAuth,
  WebSearchProvider,
  WebSearchResult,
} from "./types";

const DEFAULT_BASE_URL = "https://api.tavily.com";

/** Same default as Exa — Tavily's `content` field is comparable in
 *  length to Exa's `summary`, so a 500-char cap is comfortable.
 *  See exa.server.ts for the rationale on the cap's lower / upper
 *  band; we share the same `web_search.exa.snippet_max_chars` env
 *  key here intentionally — it's a UI-shaped budget, not provider-
 *  shaped, so a single knob keeps cards visually consistent across
 *  providers. */
const DEFAULT_SNIPPET_MAX_CHARS = 500;

/** Tavily's two depths:
 *   - "basic"   (default): faster, cheaper, 1 chunk per source
 *   - "advanced": deeper extraction, multiple chunks, costs more credits
 *  Mirrors Tavily's own default. Env knob lets an operator opt into
 *  the costlier path for higher-stakes deployments. */
type SearchDepth = "basic" | "advanced";
const VALID_SEARCH_DEPTHS = new Set<SearchDepth>(["basic", "advanced"]);

function resolveSearchDepth(): SearchDepth {
  const raw = getConfig("web_search.tavily.search_depth", "basic");
  return VALID_SEARCH_DEPTHS.has(raw as SearchDepth)
    ? (raw as SearchDepth)
    : "basic";
}

function resolveSnippetMaxChars(): number {
  const v = getConfigNumber(
    "web_search.exa.snippet_max_chars",
    DEFAULT_SNIPPET_MAX_CHARS,
  );
  if (v < 100) return 100;
  if (v > 8000) return 8000;
  return v;
}

/**
 * Tightly-typed view of the subset of Tavily's response we read.
 * Tavily's full schema is wider (score, raw_content, images, …); we
 * don't depend on anything outside this. Anything we don't list is
 * silently ignored.
 */
interface TavilySearchResponse {
  results?: Array<{
    title?: string | null;
    url?: string | null;
    /** Query-relevant excerpt; mapped to WebSearchResult.snippet. */
    content?: string | null;
    /** Populated only when `topic: "news"`. We use `topic: "general"`
     *  in V1, so this is typically absent. */
    published_date?: string | null;
    /** Per-result favicon URL. Returned when `include_favicon: true`. */
    favicon?: string | null;
  }>;
}

export const tavilyProvider: WebSearchProvider = {
  id: "tavily",
  displayName: "Tavily",
  async search(
    { query, topK, signal }: { query: string; topK: number; signal: AbortSignal },
    { apiKey, restUrl }: WebSearchAuth,
  ): Promise<WebSearchResult[]> {
    const baseUrl: string = (restUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const endpoint: string = `${baseUrl}/search`;

    const snippetMaxChars = resolveSnippetMaxChars();
    const searchDepth = resolveSearchDepth();

    const body = {
      query,
      max_results: topK,
      search_depth: searchDepth,
      include_favicon: true,
      // Explicitly false even though it's the default — guards
      // against Tavily flipping the default in a future version
      // (the "answer" field would inflate our tool result without
      // matching the card-list UI shape).
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        // Modern Bearer auth — Tavily still accepts `api_key` in the
        // body for backward compat, but their docs prefer this form.
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errBody = await safeReadText(res, 500);
      throw new ProviderHttpError("tavily", res.status, errBody);
    }

    const data: TavilySearchResponse = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .map<WebSearchResult | null>((r) => normaliseResult(r, snippetMaxChars))
      .filter((r): r is WebSearchResult => r !== null)
      .slice(0, topK);
  },
};

/**
 * Map one Tavily hit onto the unified `WebSearchResult` shape.
 * Drops hits without a usable URL — they're meaningless to the LLM.
 *
 * `snippetMax` is threaded through (rather than read inside) so a
 * single `search()` call uses one consistent cap.
 */
function normaliseResult(
  r: NonNullable<TavilySearchResponse["results"]>[number],
  snippetMax: number,
): WebSearchResult | null {
  const url = typeof r.url === "string" ? r.url : "";
  if (!url) return null;

  const title = typeof r.title === "string" && r.title.length > 0 ? r.title : url;
  const rawSnippet =
    typeof r.content === "string" && r.content.length > 0 ? r.content : "";
  const snippet: string = truncate(rawSnippet, snippetMax);

  const result: WebSearchResult = { title, url, snippet };
  if (typeof r.published_date === "string" && r.published_date.length > 0) {
    result.publishedAt = r.published_date;
  }
  // Tavily does not return per-result `image` (only a top-level
  // `images: string[]` when `include_images: true`, which we don't
  // request) — leave `result.image` undefined; the UI's letter-
  // avatar / favicon fallback chain handles the absence cleanly.
  if (typeof r.favicon === "string" && r.favicon.length > 0) {
    result.favicon = r.favicon;
  }
  return result;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

async function safeReadText(res: Response, max: number): Promise<string> {
  try {
    const text = await res.text();
    return text.length <= max ? text : `${text.slice(0, max)}…`;
  } catch {
    return "";
  }
}
