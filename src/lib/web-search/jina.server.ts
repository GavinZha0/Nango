/**
 * Jina Search provider (https://jina.ai — `s.jina.ai` endpoint).
 *
 * Endpoint:   GET {restUrl ?? "https://s.jina.ai"}/<encoded query>
 * Auth:       Authorization: Bearer <apiKey>
 *             — Optional. Anonymous calls work and are subject to a
 *             tighter rate cap (~100 RPM); a free API key roughly
 *             doubles it. Either way, no per-call monetary cost on
 *             the free tier (within rate limits).
 * Request:    URL-encoded query in the path; behaviour is controlled
 *             via X-headers and the `Accept` header. We set
 *             `Accept: application/json` so the response is the
 *             structured `{ data: [...] }` shape rather than a
 *             concatenated Markdown blob.
 * Response:   { code, status, data: [{ title, url, description?,
 *                                      content, publishedTime? }] }
 *
 * SNIPPET STRATEGY:
 *   Jina returns BOTH `description` (search-engine SERP blurb, often
 *   empty in practice) and `content` (Jina's own extracted page
 *   excerpt, hundreds of characters of Markdown). We prefer
 *   `description` when non-empty (it's intentionally concise), and
 *   fall back to `content` truncated to the shared snippet cap.
 *
 * KNOWN DIFFERENCES from Exa / Tavily / Brave:
 *   - Anonymous-friendly: if a credential lacks an API key, the
 *     call still goes out (Jina accepts it). The runtime resolver
 *     enforces a non-empty apiKey before reaching us, so in
 *     practice this only matters when Jina-the-credential is the
 *     ONLY enabled search credential and the operator forgot to
 *     fill the key — we surface a clean UPSTREAM_HTTP at that
 *     point, no special handling needed here.
 *   - No per-result `favicon` or `image` in the default response
 *     shape — the CardListBlock UI degrades to the letter-avatar.
 *
 * ENGINE MODE (default = `direct`):
 *   Jina exposes two retrieval modes via `X-Engine`:
 *     - "direct"  (DEFAULT here): returns raw SERP results, no
 *       per-page content extraction. ~1-2s typical. Snippet comes
 *       from `description`. Matches Brave's latency / shape.
 *     - "default" (Jina's own default, our opt-in): Jina extracts
 *       each result page server-side, producing rich `content`
 *       excerpts. Typical 3-7s, cold-cache up to 15s+. With our
 *       10s tool timeout this regularly aborts — that's why we
 *       flip the default to `direct` even though Jina itself
 *       prefers the slower mode.
 *   Operators wanting richer content over speed can set
 *   `web_search.jina.engine=default` in env.
 *
 * KNOBS (env-tunable):
 *   - web_search.exa.snippet_max_chars   (shared UI budget)
 *   - web_search.jina.engine             ("direct" | "default")
 */

import "server-only";

import { getConfig, getConfigNumber } from "@/lib/config";

import { ProviderHttpError } from "./errors";
import type {
  WebSearchAuth,
  WebSearchProvider,
  WebSearchResult,
} from "./types";

const DEFAULT_BASE_URL = "https://s.jina.ai";

/** Same default cap as Exa / Tavily / Brave. */
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

type JinaEngine = "default" | "direct";

function resolveEngine(): JinaEngine {
  // Default to "direct" (fast SERP, ~1-2s) rather than Jina's own
  // default mode (content extraction, 3-7s+, often times out
  // against our 10s tool budget). See the header comment.
  const raw = getConfig("web_search.jina.engine", "direct");
  return raw === "default" ? "default" : "direct";
}

/**
 * Subset of Jina's response shape we read. Jina also returns
 * `meta`, `usage`, etc.; we silently ignore those.
 */
interface JinaSearchResponse {
  code?: number | null;
  data?: Array<{
    title?: string | null;
    url?: string | null;
    /** SERP-style short description; often empty. */
    description?: string | null;
    /** Jina's full extracted content (Markdown). Used as fallback. */
    content?: string | null;
    /** ISO-8601 publication time when Jina can determine it. */
    publishedTime?: string | null;
  }>;
}

export const jinaProvider: WebSearchProvider = {
  id: "jina",
  displayName: "Jina",
  async search(
    { query, topK, signal }: { query: string; topK: number; signal: AbortSignal },
    { apiKey, restUrl }: WebSearchAuth,
  ): Promise<WebSearchResult[]> {
    const baseUrl: string = (restUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Jina takes the query as a URL path segment. encodeURIComponent
    // handles spaces, non-ASCII, and reserved characters cleanly.
    const endpoint = `${baseUrl}/${encodeURIComponent(query)}`;

    const snippetMaxChars = resolveSnippetMaxChars();
    const engine = resolveEngine();

    const headers: Record<string, string> = {
      accept: "application/json",
      // Tell Jina what shape we want for the content (Markdown is
      // already what `content` ships as, but being explicit avoids
      // any future format-default drift).
      "X-Return-Format": "markdown",
    };
    // Bearer auth is optional on Jina; only attach when the
    // credential actually carries a key.
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    if (engine === "direct") {
      // Direct mode skips content extraction — much faster, shorter
      // snippets. Opt-in via env, off by default.
      headers["X-Engine"] = "direct";
    }

    const res = await fetch(endpoint, { method: "GET", headers, signal });

    if (!res.ok) {
      const errBody = await safeReadText(res, 500);
      throw new ProviderHttpError("jina", res.status, errBody);
    }

    const data: JinaSearchResponse = await res.json();
    const rows = Array.isArray(data.data) ? data.data : [];
    return rows
      .map<WebSearchResult | null>((r) => normaliseResult(r, snippetMaxChars))
      .filter((r): r is WebSearchResult => r !== null)
      .slice(0, topK);
  },
};

function normaliseResult(
  r: NonNullable<JinaSearchResponse["data"]>[number],
  snippetMax: number,
): WebSearchResult | null {
  const url = typeof r.url === "string" ? r.url : "";
  if (!url) return null;

  const title = typeof r.title === "string" && r.title.length > 0 ? r.title : url;
  // Snippet priority: short SERP `description` when populated,
  // otherwise the longer `content` truncated to the shared cap.
  // `content` is Markdown; truncation may chop mid-link, but the
  // user-facing card renders it as plain text so dangling syntax
  // is benign.
  const rawSnippet =
    (typeof r.description === "string" && r.description.length > 0 && r.description) ||
    (typeof r.content === "string" && r.content.length > 0 && r.content) ||
    "";
  const snippet: string = truncate(rawSnippet, snippetMax);

  const result: WebSearchResult = { title, url, snippet };
  if (typeof r.publishedTime === "string" && r.publishedTime.length > 0) {
    result.publishedAt = r.publishedTime;
  }
  // No image / favicon in the default response shape — leave
  // undefined; the card_list UI handles the absence cleanly.
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
