/**
 * Exa search provider (https://exa.ai).
 *
 * Endpoint:   POST {restUrl ?? "https://api.exa.ai"}/search
 * Auth:       x-api-key: <apiKey>
 * Request:    { query, numResults, type: "auto",
 *               contents: { summary: { query }, text, livecrawl } }
 * Response:   { results: [{ title, url, publishedDate?,
 *                           summary?, text?, image?, favicon? }] }
 *
 * `contents.summary: { query }` asks Exa to run a server-side LLM
 * over each result page and produce a concise, query-relevant
 * blurb (typically 1-3 sentences). We prefer this over the raw
 * `text` excerpt because:
 *   - it's already pre-summarised, so the LLM consuming our tool
 *     result sees ~10× fewer tokens per hit, and
 *   - the UI card can render the whole thing in 2-4 lines without
 *     needing a separate clip / truncation pass.
 *
 * `text` is still requested (and returned as a fallback in
 * `normaliseResult`) so a result for which Exa cannot produce a
 * summary still has *something* in `snippet`.
 *
 * `livecrawl: "preferred"` nudges Exa to attempt a fresh crawl so
 * fast-moving topics (news, prices) return current data rather than
 * a cached crawl. Exa's `/search` natively returns `image` (OG / hero
 * image) and `favicon` on each result — we forward them so the
 * chat-side renderer can show image grids and per-result icons.
 *
 * The snippet length cap and the livecrawl mode are env-tunable
 * (`web_search.exa.snippet_max_chars`, `web_search.exa.livecrawl`)
 * so an operator can dial token cost vs informativeness without a
 * code change.
 */

import "server-only";

import { getConfig, getConfigNumber } from "@/lib/config";

import { ProviderHttpError } from "./errors";
import type {
  WebSearchAuth,
  WebSearchProvider,
  WebSearchResult,
} from "./types";

const DEFAULT_BASE_URL = "https://api.exa.ai";

/** Default 500 chars per snippet — generous upper bound on Exa's
 *  summary (typically 100-200 chars) plus a safety margin for the
 *  rare summary-less hit that falls back to `text`. With topK ≤ 10
 *  that's ≤ ~1k tokens of snippet payload per call, very cheap.
 *
 *  Earlier iteration used 1500 to give the LLM the full page
 *  excerpt; once we switched to query-relevant summaries via
 *  Exa's `summary` feature the cap dropped to 500 because there's
 *  no longer anything useful in the 500-1500 range to retain. */
const DEFAULT_SNIPPET_MAX_CHARS = 500;

/** Exa's three modes: "always" (force live), "fallback" (cache then
 *  live on miss), "preferred" (try live, accept cache on slow miss).
 *  "preferred" is the right default for chat — best freshness without
 *  pinning every result on a slow crawl. */
type LivecrawlMode = "always" | "fallback" | "preferred";
const VALID_LIVECRAWL_MODES = new Set<LivecrawlMode>([
  "always",
  "fallback",
  "preferred",
]);

function resolveLivecrawl(): LivecrawlMode {
  const raw = getConfig("web_search.exa.livecrawl", "preferred");
  return VALID_LIVECRAWL_MODES.has(raw as LivecrawlMode)
    ? (raw as LivecrawlMode)
    : "preferred";
}

function resolveSnippetMaxChars(): number {
  const v = getConfigNumber(
    "web_search.exa.snippet_max_chars",
    DEFAULT_SNIPPET_MAX_CHARS,
  );
  // Clamp to a sane band — refuse 0 (silently strips snippets) and
  // refuse absurdly large values that would explode tool-result token
  // cost without operator awareness.
  if (v < 100) return 100;
  if (v > 8000) return 8000;
  return v;
}

/**
 * Tightly-typed view of the subset of Exa's response we read. Exa's
 * full schema is wider (score, author, …); we don't depend on
 * anything outside this. Anything we don't list here is silently
 * ignored.
 */
interface ExaSearchResponse {
  results?: Array<{
    title?: string | null;
    url?: string | null;
    publishedDate?: string | null;
    /** Query-relevant LLM summary produced by Exa (1-3 sentences).
     *  Preferred snippet source — see normaliseResult priority. */
    summary?: string | null;
    /** Raw page text excerpt — used as a fallback when Exa could
     *  not produce a `summary` (rare, e.g. paywalled / robots-blocked
     *  pages). */
    text?: string | null;
    /** Page hero / OG image. Empty / non-string treated as absent. */
    image?: string | null;
    /** Site favicon. Empty / non-string treated as absent. */
    favicon?: string | null;
    /** Last-resort snippet source (Exa returns these when neither
     *  summary nor text is available). */
    highlights?: string[] | null;
  }>;
}

export const exaProvider: WebSearchProvider = {
  id: "exa",
  displayName: "Exa",
  async search(
    { query, topK, signal }: { query: string; topK: number; signal: AbortSignal },
    { apiKey, restUrl }: WebSearchAuth,
  ): Promise<WebSearchResult[]> {
    const baseUrl: string = (restUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const endpoint: string = `${baseUrl}/search`;

    const snippetMaxChars = resolveSnippetMaxChars();
    const livecrawl = resolveLivecrawl();

    const body = {
      query,
      numResults: topK,
      // `auto` lets Exa choose between neural and keyword per query;
      // empirically best default for unconstrained agent queries.
      type: "auto" as const,
      contents: {
        // Primary snippet source — query-aware LLM summary. Exa
        // runs its own LLM over the result page and returns a
        // 1-3 sentence blurb explicitly answering `query`.
        summary: { query },
        // Fallback snippet source — raw page text excerpt. Capped
        // locally; mirrored on Exa side so we don't pay for bytes
        // we'd discard. Only consulted in `normaliseResult` when
        // the summary is absent.
        text: { maxCharacters: snippetMaxChars },
        // Freshness knob — see resolveLivecrawl(). Forwarded once at
        // the contents level (Exa applies it to every result).
        livecrawl,
      },
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      // Surface the status + a short body excerpt so admins can
      // debug from the run timeline without enabling verbose logs.
      const errBody = await safeReadText(res, 500);
      throw new ExaHttpError(res.status, errBody);  // see class def below
    }

    const data: ExaSearchResponse = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .map<WebSearchResult | null>((r) => normaliseResult(r, snippetMaxChars))
      .filter((r): r is WebSearchResult => r !== null)
      .slice(0, topK);
  },
};

/**
 * Map one Exa hit onto the unified `WebSearchResult` shape. Drops
 * hits without a usable URL — they're meaningless to the LLM.
 *
 * `snippetMax` is threaded through (rather than read inside) so a
 * single `search()` call uses one consistent cap even if the env
 * config changes mid-call — and so test code can drive truncation
 * without mocking the config module.
 */
function normaliseResult(
  r: NonNullable<ExaSearchResponse["results"]>[number],
  snippetMax: number,
): WebSearchResult | null {
  const url = typeof r.url === "string" ? r.url : "";
  if (!url) return null;

  const title = typeof r.title === "string" && r.title.length > 0 ? r.title : url;

  // Snippet source priority:
  //   1. `summary` — Exa's query-relevant LLM summary (1-3 sentences,
  //      already concise enough for the UI card, already query-aware
  //      so the LLM doesn't need to re-summarise);
  //   2. `text`    — raw page text excerpt, used when Exa could not
  //      produce a summary (paywalled / robots-blocked / very short
  //      pages);
  //   3. `highlights[0]` — Exa's keyword excerpt, last resort.
  // Empty string for results with nothing usable — the caller still
  // keeps the result (URL + title can be useful on their own).
  const rawSnippet: string =
    (typeof r.summary === "string" && r.summary) ||
    (typeof r.text === "string" && r.text) ||
    (Array.isArray(r.highlights) && typeof r.highlights[0] === "string"
      ? r.highlights[0]
      : "") ||
    "";
  const snippet: string = truncate(rawSnippet, snippetMax);

  const result: WebSearchResult = { title, url, snippet };
  if (typeof r.publishedDate === "string" && r.publishedDate.length > 0) {
    result.publishedAt = r.publishedDate;
  }
  // Forward image / favicon when Exa returned a non-empty string for
  // them. We do NOT validate the URL — broken images are silently
  // dropped client-side (see WebSearchResult JSDoc).
  if (typeof r.image === "string" && r.image.length > 0) {
    result.image = r.image;
  }
  if (typeof r.favicon === "string" && r.favicon.length > 0) {
    result.favicon = r.favicon;
  }
  return result;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Strip mid-word break with an ellipsis so the LLM clearly sees
  // the snippet is truncated.
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

/**
 * Exa-specific HTTP error. Kept as a thin subclass of
 * {@link ProviderHttpError} so existing tests (and a `throw new
 * ExaHttpError(...)` call site) keep working, while the runtime
 * tool can catch a single generic `ProviderHttpError` for any
 * provider.
 */
export class ExaHttpError extends ProviderHttpError {
  constructor(status: number, body: string) {
    super("exa", status, body);
    this.name = "ExaHttpError";
  }
}
