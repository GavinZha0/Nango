/**
 * SearXNG search provider (self-hosted metasearch engine).
 *
 * Endpoint:   GET {restUrl}/search?q=<query>&format=json
 * Auth:       None. SearXNG's /search endpoint is unauthenticated.
 *             Credentials created in the UI still carry a value in the
 *             API-key field; anonymous placeholders ("none", "empty", …)
 *             mean "send no Authorization header". A non-placeholder key
 *             is forwarded as a Bearer token for deployments behind an
 *             authenticating reverse proxy.
 * Request:    q, format=json (required — JSON is disabled by default),
 *             plus optional language/categories/safesearch from config.
 * Response:   { results: [{ title, url, content, publishedDate?,
 *                           thumbnail?, img_src? }],
 *               unresponsive_engines: [...] }
 *
 * SNIPPET STRATEGY:
 *   `content` is the search engine's SERP extract (often shortened by
 *   the upstream engine). Unlike Exa it is not an LLM-generated answer,
 *   so the tool description must not promise query-relevant summaries.
 *   HTML tags are stripped defensively and whitespace is collapsed
 *   before truncation.
 *
 * IMAGES:
 *   `thumbnail` / `img_src` are external URLs. SearXNG's image_proxy
 *   setting only proxies its own UI, NOT the JSON payload, so forwarding
 *   these as `image` would make the browser hotlink the origin site and
 *   leak the user's IP. Off by default; operators can opt in with
 *   `web_search.searxng.include_thumbnails`.
 *
 * KNOBS (Admin -> Config):
 *   - web_search.timeout                     (shared call budget, default 30 s)
 *   - web_search.exa.snippet_max_chars       (shared UI budget)
 *   - web_search.searxng.language            (empty = instance default)
 *   - web_search.searxng.categories          (default "general")
 *   - web_search.searxng.safesearch          (0 / 1 / 2)
 *   - web_search.searxng.include_thumbnails  (default false)
 */

import "server-only";

import { getConfig, getConfigBoolean, getConfigNumber } from "@/lib/config";
import { isAnonymousPlaceholder } from "@/lib/credentials/crypto";
import { logger } from "@/lib/observability/logger";

import { isAbortError, ProviderHttpError, ProviderNetworkError } from "./errors";
import type {
  WebSearchAuth,
  WebSearchProvider,
  WebSearchResult,
} from "./types";

/** Same default cap as Exa / Tavily / Brave / Jina. */
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

function resolveLanguage(): string {
  return getConfig("web_search.searxng.language", "").trim();
}

function resolveCategories(): string {
  return getConfig("web_search.searxng.categories", "general").trim();
}

function resolveSafeSearch(): string | null {
  const raw = getConfig("web_search.searxng.safesearch", "0").trim();
  return raw === "0" || raw === "1" || raw === "2" ? raw : null;
}

/**
 * Subset of SearXNG's JSON response we read. `unresponsive_engines` is
 * only inspected for diagnostics (engine name + error pairs, shape varies
 * slightly between versions).
 */
interface SearxngSearchResponse {
  results?: Array<{
    title?: string | null;
    url?: string | null;
    content?: string | null;
    publishedDate?: string | null;
    thumbnail?: string | null;
    img_src?: string | null;
  }>;
  unresponsive_engines?: unknown[] | null;
}

export const searxngProvider: WebSearchProvider = {
  id: "searxng",
  displayName: "SearXNG",
  async search(
    { query, topK, signal }: { query: string; topK: number; signal: AbortSignal },
    { apiKey, restUrl }: WebSearchAuth,
  ): Promise<WebSearchResult[]> {
    const baseUrl = (restUrl ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) {
      // The credential row is the only place the instance URL lives.
      // Fail with an actionable message instead of silently defaulting
      // to localhost, which is wrong inside the nango-app container.
      throw new Error(
        "SearXNG credential is missing its Base URL. Set it to " +
          "http://127.0.0.1:8680 (pnpm dev on the host) or " +
          "http://searxng:8080 (nango-app inside Docker).",
      );
    }

    const url = new URL(`${baseUrl}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    const language = resolveLanguage();
    if (language) url.searchParams.set("language", language);

    const categories = resolveCategories();
    if (categories) url.searchParams.set("categories", categories);

    const safesearch = resolveSafeSearch();
    if (safesearch) url.searchParams.set("safesearch", safesearch);

    const headers: Record<string, string> = { accept: "application/json" };
    // CONTRACT: placeholder values are the project-wide convention for
    // "this credential has no secret" (the credential form still forces
    // a non-empty field). Never send them as a Bearer token.
    if (apiKey && !isAnonymousPlaceholder(apiKey)) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers, signal });
    } catch (err) {
      // Cancellation must stay an AbortError so the runtime maps it to
      // UPSTREAM_TIMEOUT instead of a network-unreachable envelope.
      if (isAbortError(err)) throw err;
      throw new ProviderNetworkError(
        "searxng",
        baseUrl,
        describeFetchCause(err),
        "With `pnpm dev` on the host use http://127.0.0.1:8680; with the " +
          "nango-app container use http://searxng:8080.",
      );
    }

    if (!res.ok) {
      throw new ProviderHttpError(
        "searxng",
        res.status,
        await safeReadText(res, 500),
        httpHint(res.status),
      );
    }

    let data: SearxngSearchResponse;
    try {
      data = (await res.json()) as SearxngSearchResponse;
    } catch {
      throw new Error(
        "SearXNG returned a non-JSON response. Ensure search.formats " +
          "includes `json` in the instance's settings.yml.",
      );
    }

    if (!Array.isArray(data.results)) {
      throw new Error("SearXNG response is missing the results array.");
    }

    const snippetMaxChars = resolveSnippetMaxChars();
    const includeThumbnails = getConfigBoolean(
      "web_search.searxng.include_thumbnails",
      false,
    );

    const results = normaliseResults(
      data.results,
      topK,
      snippetMaxChars,
      includeThumbnails,
    );

    // Zero results with unresponsive engines is the signature of a
    // reachable instance whose upstream engines are blocked/timing out.
    // Surface it in logs so admins do not debug Nango's HTTP layer first.
    if (
      results.length === 0 &&
      Array.isArray(data.unresponsive_engines) &&
      data.unresponsive_engines.length > 0
    ) {
      logger.warn(
        {
          component: "web-search",
          event: "searxng_no_results",
          unresponsiveEngines: data.unresponsive_engines.slice(0, 10),
        },
        "SearXNG returned no results and reported unresponsive engines",
      );
    }

    return results;
  },
};

function normaliseResults(
  rows: NonNullable<SearxngSearchResponse["results"]>,
  topK: number,
  snippetMax: number,
  includeThumbnails: boolean,
): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    // Search engines occasionally leak non-http links (javascript:,
    // data:, relative paths). They are not usable citations.
    if (!isHttpUrl(url) || seen.has(url)) continue;

    const title =
      typeof row.title === "string" && row.title.trim().length > 0
        ? row.title.trim()
        : url;

    const snippet = truncate(cleanSnippet(row.content), snippetMax);

    const result: WebSearchResult = { title, url, snippet };

    if (
      typeof row.publishedDate === "string" &&
      row.publishedDate.trim().length > 0
    ) {
      result.publishedAt = row.publishedDate.trim();
    }

    if (includeThumbnails) {
      const image = firstHttpUrl(row.thumbnail, row.img_src);
      if (image) result.image = image;
    }

    // No favicon: SearXNG does not expose one in the JSON payload, and a
    // third-party favicon service would leak the domain list.
    seen.add(url);
    out.push(result);
    if (out.length >= topK) break;
  }

  return out;
}

function isHttpUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function firstHttpUrl(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && isHttpUrl(value.trim())) {
      return value.trim();
    }
  }
  return null;
}

function cleanSnippet(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function httpHint(status: number): string | undefined {
  if (status === 403) {
    return "Ensure SearXNG's search.formats includes `json` and the instance URL is correct.";
  }
  if (status === 429) {
    return "SearXNG's limiter rejected the request; set SEARXNG_LIMITER=false for a local instance.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "SearXNG could not reach its upstream engines; check the container logs.";
  }
  return undefined;
}

/**
 * Undici wraps DNS/connection failures in `TypeError("fetch failed")`
 * with the real reason in `cause`. Surface it so the admin sees
 * "getaddrinfo ENOTFOUND searxng" instead of just "fetch failed".
 */
function describeFetchCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `${err.name}: ${err.message}`;
}

async function safeReadText(res: Response, max: number): Promise<string> {
  try {
    const text = await res.text();
    return text.length <= max ? text : `${text.slice(0, max)}…`;
  } catch {
    return "";
  }
}
