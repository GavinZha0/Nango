/**
 * Server-side `web_search` agent tool.
 *
 * Pattern parity with `run_code_in_sandbox`: zero-arg factory, no
 * per-agent binding, registered in `lib/builtin-tools/catalog.ts`.
 * Credential selection happens entirely server-side via
 * `resolveSearchCredential()`; the LLM never sees the provider list
 * nor the api key.
 */

import "server-only";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import { getConfigMs } from "@/lib/config";
import { logger } from "@/lib/observability/logger";

import { NotImplementedError, ProviderHttpError } from "./errors";
import { resolveSearchCredential } from "./lookup.server";
import { getWebSearchProvider } from "./registry.server";
import { webSearchArgsSchema } from "./schema";
import type { WebSearchErr, WebSearchResultEnvelope } from "./schema";
import type { WebSearchProviderId } from "./types";

// Re-export the schema + envelope types so legacy callers can keep
// importing from this module path even though the canonical home is
// now `./schema` (client-safe).
export { webSearchArgsSchema } from "./schema";
export type {
  WebSearchArgs,
  WebSearchOk,
  WebSearchErr,
  WebSearchResultEnvelope,
} from "./schema";

// Tool factory

/** Wall-clock budget per call. SECONDS in env, ms in code (project
 *  convention; see ssh/sandbox tools). */
const requestTimeoutMs = (): number =>
  getConfigMs("web_search.timeout", 10);

export function buildWebSearchTool(): ToolDefinition {
  return defineTool({
    name: "web_search",
    description:
      "Search the public web for fresh information not in your training " +
      "data. Uses a configured search provider (Exa, Tavily, or Brave). " +
      "Returns the top results — the upstream actually used is reported " +
      "as `provider`. On success: " +
      "{ ok: true, provider, results: [{ title, url, snippet, publishedAt?, image?, favicon? }] }. " +
      "On failure: { ok: false, error, message } where `error` is one of " +
      "NO_PROVIDER, AUTH_MISSING, UPSTREAM_HTTP, UPSTREAM_TIMEOUT, " +
      "INVALID_RESPONSE. " +
      "`snippet` is a CONCISE, QUERY-RELEVANT SUMMARY (1-3 sentences) " +
      "produced by the search provider's own LLM — not a raw page " +
      "excerpt. It is suitable to quote or paraphrase directly when " +
      "answering the user; verify by visiting the URL only if the " +
      "claim is high-stakes or contested. " +
      "COST AWARENESS — WHEN TO CALL: every web_search call consumes " +
      "provider quota AND adds a card to the user's Outcomes panel. " +
      "For open-ended questions (\"what's new\", \"top N news\", \"latest " +
      "in X\"), START WITH ONE broad query and reply from those " +
      "results. Only fire a follow-up search if the FIRST result set " +
      "is clearly inadequate — e.g. fewer than 3 relevant hits, all " +
      "results predate the user's time window, or your initial query " +
      "missed the user's intent. For deep research / high-stakes " +
      "claims (academic, legal, medical, verifiable facts that " +
      "contradict your training data), multi-source triangulation " +
      "across 2-3 searches IS appropriate. DO NOT chain 4 or more " +
      "searches on the same user turn — that's almost always wasted " +
      "quota and panel clutter. " +
      "IMPORTANT — RENDERING: every successful search automatically " +
      "appears as a card in the user's Outcomes panel (right side of " +
      "the workspace), with thumbnails, titles, sources, and clickable " +
      "links rendered from the result data. Your job is to write a " +
      "TEXT narration of what you found — DO NOT embed `image`, " +
      "`favicon`, or `url` values as inline markdown (no `![alt](image)`, " +
      "no `[title](url)`); the user already sees those visually. " +
      "CITATION SYNTAX — REQUIRED: when referencing a specific search " +
      "result in your chat narration, use [N] notation where N is the " +
      "1-based position of the result in the `results` array (first " +
      "result = [1], second = [2], etc.). The Outcomes panel renders " +
      "matching numbered cards [1], [2], … so the user can " +
      "cross-reference your claims with the underlying sources. " +
      "Cite specific sources for every claim drawn from the search " +
      "results — do not paraphrase a source without citing it. " +
      "Multiple citations per claim use [1][2] form (no separator). " +
      "Example: \"The market grew 15% in Q4 [1][2], driven primarily " +
      "by enterprise adoption [3].\"",
    parameters: webSearchArgsSchema,
    execute: async (args, ctx?: { abortSignal?: AbortSignal }): Promise<WebSearchResultEnvelope> => {
      const resolution = await resolveSearchCredential();
      if (!resolution.ok) return resolution;
      const { provider: providerId, apiKey, restUrl, credentialId } = resolution.resolved;

      const provider = getWebSearchProvider(providerId);

      // Per-call timeout. We compose the caller's abortSignal (if any)
      // with our own deadline so cancellation from either side wins.
      //
      // CRITICAL: pass NO `reason` to `.abort()`. Earlier iterations
      // called `.abort("timeout")` for diagnostic purposes, but
      // Node 22+ undici fetch propagates the raw signal.reason as
      // the thrown value (not wrapped in a DOMException). A string
      // reason → fetch throws the literal string, which slips past
      // our `isAbortError` check (which only recognises
      // DOMException / Error with name="AbortError") and ends up
      // classified as INVALID_RESPONSE — losing the proper
      // UPSTREAM_TIMEOUT envelope. The default reason produced by
      // `.abort()` with no arg IS a `DOMException("…", "AbortError")`,
      // so leaving it bare keeps the abort classification correct
      // without sacrificing diagnostics (the catch site still logs
      // the err.message).
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), requestTimeoutMs());
      const onUpstreamAbort = (): void => timeoutController.abort();
      ctx?.abortSignal?.addEventListener("abort", onUpstreamAbort, { once: true });

      try {
        const results = await provider.search(
          { query: args.query, topK: args.topK, signal: timeoutController.signal },
          { apiKey, restUrl },
        );
        return { ok: true, provider: providerId, results };
      } catch (err) {
        return mapProviderError(err, providerId, credentialId);
      } finally {
        clearTimeout(timer);
        ctx?.abortSignal?.removeEventListener("abort", onUpstreamAbort);
      }
    },
  });
}

/**
 * Translate a provider throw into the typed error envelope. Logs at
 * `warn` so admins see the upstream detail in pino output without it
 * polluting the LLM-facing message string.
 */
function mapProviderError(
  err: unknown,
  provider: WebSearchProviderId,
  credentialId: string,
): WebSearchErr {
  // Timeout / cancellation — AbortError comes in two shapes depending
  // on whether fetch or AbortSignal raised it.
  if (isAbortError(err)) {
    logger.warn(
      { component: "web-search", event: "timeout", provider, credentialId },
      "web_search upstream call timed out or was cancelled",
    );
    return {
      ok: false,
      error: "UPSTREAM_TIMEOUT",
      message: `web_search timed out (${Math.round(requestTimeoutMs() / 1000)}s). ` +
        "Try a shorter / more focused query, or retry once.",
    };
  }

  if (err instanceof NotImplementedError) {
    return {
      ok: false,
      error: "NOT_IMPLEMENTED",
      message:
        `web_search provider "${err.provider}" is registered but not ` +
        "implemented in this build. Configure a credential for a different " +
        "search provider (e.g. Exa).",
    };
  }

  if (err instanceof ProviderHttpError) {
    logger.warn(
      {
        component: "web-search",
        event: "upstream_http",
        provider,
        credentialId,
        status: err.status,
        body: err.body,
      },
      "web_search upstream returned non-2xx",
    );
    // Provider-name capitalisation in the user-facing message uses
    // the provider id (lowercase) — short, recognisable, and avoids
    // a separate "display name" mapping. The error code itself is
    // provider-agnostic so consumers branch on `error`, not on
    // message string parsing.
    return {
      ok: false,
      error: "UPSTREAM_HTTP",
      message:
        `${err.provider} returned HTTP ${err.status}. ` +
        "Check the credential's API key or upstream quota.",
    };
  }

  // Anything else — most likely JSON parse / network error.
  const message = err instanceof Error ? err.message : String(err);
  logger.warn(
    {
      component: "web-search",
      event: "invalid_response",
      provider,
      credentialId,
      err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
    },
    "web_search upstream response could not be processed",
  );
  return {
    ok: false,
    error: "INVALID_RESPONSE",
    message: `web_search failed: ${message}`,
  };
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}
