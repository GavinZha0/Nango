/**
 * Brave Search provider (https://brave.com/search/api/).
 *
 * Endpoint:   GET {restUrl ?? "https://api.search.brave.com"}/res/v1/web/search
 * Auth:       X-Subscription-Token: <apiKey>
 *             Accept: application/json
 *             (Brave's own header name — NOT Authorization-Bearer.
 *             This is the differentiator from Exa / Tavily; per-
 *             provider auth shape is fully encapsulated here.)
 * Request:    Query params — q, count, country, search_lang, ui_lang.
 *             Brave is GET-based (unlike POST for Exa / Tavily),
 *             so all knobs go in the URL.
 * Response:   { web: { results: [{ title, url, description,
 *                       meta_url: { favicon? },
 *                       thumbnail: { src? },
 *                       page_age?, age? }] }, ... }
 *
 * Brave's `description` field is the short blurb shown under each
 * SERP result on brave.com — concise (~150-300 chars) and already
 * query-relevant, so it maps directly onto `WebSearchResult.snippet`
 * with the same semantics as Exa's `summary` and Tavily's `content`.
 *
 * NOTABLE FEATURES vs the other providers:
 *   - Brave returns BOTH a per-result `thumbnail.src` (hero image,
 *     when the page has one) AND `meta_url.favicon` (site icon).
 *     Both flow into the WebSearchResult contract; the card_list UI
 *     uses image when present, falls back to favicon otherwise.
 *   - `page_age` is a proper ISO-8601 timestamp when Brave can
 *     determine the page's date. The legacy `age` field is a
 *     human-readable string ("2 weeks ago") and we DO NOT consume
 *     it — only `page_age` maps to `publishedAt` so callers get a
 *     consistent format across providers.
 *   - Response is nested under `web` rather than top-level (Brave
 *     mixes web / news / videos / images in one response; we only
 *     consume the `web` channel for V1).
 *
 * KNOBS (env-tunable):
 *   - web_search.brave.country     (default "us")
 *   - web_search.brave.search_lang (default "en")
 *   - web_search.exa.snippet_max_chars  (shared with Exa/Tavily —
 *     it's a UI-shaped budget, not provider-shaped, so a single
 *     knob keeps cards visually consistent)
 */

import "server-only";

import { getConfig, getConfigNumber } from "@/lib/config";

import { ProviderHttpError } from "./errors";
import type {
  WebSearchAuth,
  WebSearchProvider,
  WebSearchResult,
} from "./types";

const DEFAULT_BASE_URL = "https://api.search.brave.com";
const SEARCH_PATH = "/res/v1/web/search";

/** Same default cap as Exa / Tavily. See the shared `snippet_max_chars`
 *  note in tavily.server.ts for why all three providers share the
 *  same env key. */
const DEFAULT_SNIPPET_MAX_CHARS = 500;

function resolveSnippetMaxChars(): number {
  const v = getConfigNumber(
    "web_search.exa.snippet_max_chars",
    DEFAULT_SNIPPET_MAX_CHARS,
  );
  if (v < 100) return 100;
  if (v > 8000) return 8000;
  return v;
}

function resolveCountry(): string {
  // Brave validates this — only ISO 2-letter country codes are
  // accepted. We don't enforce that here (an invalid value just
  // produces a 4xx that the runtime tool surfaces as UPSTREAM_HTTP);
  // operators pick the value, we just forward it.
  return getConfig("web_search.brave.country", "us");
}

function resolveSearchLang(): string {
  // Brave accepts ISO 639-1 codes plus a few extensions; same
  // forward-without-validate stance as country.
  return getConfig("web_search.brave.search_lang", "en");
}

/**
 * Tightly-typed view of the subset of Brave's response we read.
 * Brave's full schema is much wider (it returns mixed result types
 * — news, videos, images, FAQ, infobox, etc. — alongside web
 * results); we only consume `web.results[]` in V1.
 */
interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string | null;
      url?: string | null;
      description?: string | null;
      /** ISO-8601 page age when Brave can determine the date. */
      page_age?: string | null;
      meta_url?: {
        /** Per-result favicon URL. */
        favicon?: string | null;
      } | null;
      thumbnail?: {
        /** Hero / preview image URL. */
        src?: string | null;
        /** Original-size source URL (we don't use it — `src` is
         *  already sized appropriately for a 64px thumbnail). */
        original?: string | null;
      } | null;
    }>;
  } | null;
}

export const braveProvider: WebSearchProvider = {
  id: "brave",
  displayName: "Brave Search",
  async search(
    { query, topK, signal }: { query: string; topK: number; signal: AbortSignal },
    { apiKey, restUrl }: WebSearchAuth,
  ): Promise<WebSearchResult[]> {
    const baseUrl: string = (restUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

    const snippetMaxChars = resolveSnippetMaxChars();
    const country = resolveCountry();
    const searchLang = resolveSearchLang();

    // Brave uses query params, not a JSON body. URLSearchParams
    // handles encoding cleanly for non-ASCII queries (Chinese,
    // emoji, …) which Brave fully supports.
    const params = new URLSearchParams({
      q: query,
      // Brave's `count` is documented as 1-20; we already clamp
      // upstream via webSearchArgsSchema (max 10).
      count: String(topK),
      country,
      search_lang: searchLang,
    });
    const endpoint = `${baseUrl}${SEARCH_PATH}?${params.toString()}`;

    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        // Brave's idiosyncratic header — NOT Authorization-Bearer.
        // The value is the raw subscription key (typically
        // "BSA…" prefix).
        "X-Subscription-Token": apiKey,
        accept: "application/json",
      },
      signal,
    });

    if (!res.ok) {
      const errBody = await safeReadText(res, 500);
      throw new ProviderHttpError("brave", res.status, errBody);
    }

    const data: BraveSearchResponse = await res.json();
    const webResults = data.web?.results;
    const results = Array.isArray(webResults) ? webResults : [];
    return results
      .map<WebSearchResult | null>((r) => normaliseResult(r, snippetMaxChars))
      .filter((r): r is WebSearchResult => r !== null)
      .slice(0, topK);
  },
};

function normaliseResult(
  r: NonNullable<NonNullable<BraveSearchResponse["web"]>["results"]>[number],
  snippetMax: number,
): WebSearchResult | null {
  const url = typeof r.url === "string" ? r.url : "";
  if (!url) return null;

  const title = typeof r.title === "string" && r.title.length > 0 ? r.title : url;
  const rawSnippet =
    typeof r.description === "string" && r.description.length > 0
      ? r.description
      : "";
  const snippet: string = truncate(rawSnippet, snippetMax);

  const result: WebSearchResult = { title, url, snippet };
  // Brave's ISO-8601 `page_age`; `age` (human-readable "2 weeks ago")
  // is intentionally not consumed — only ISO timestamps flow to
  // `publishedAt` so the UI can format dates consistently.
  if (typeof r.page_age === "string" && r.page_age.length > 0) {
    result.publishedAt = r.page_age;
  }
  if (typeof r.thumbnail?.src === "string" && r.thumbnail.src.length > 0) {
    result.image = r.thumbnail.src;
  }
  if (typeof r.meta_url?.favicon === "string" && r.meta_url.favicon.length > 0) {
    result.favicon = r.meta_url.favicon;
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
