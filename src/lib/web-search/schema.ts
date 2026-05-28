/**
 * Client-safe schema + result shapes for the `web_search` tool.
 *
 * NO `server-only` import here — this file is consumed by both the
 * server tool (`runtime-tools.ts`) AND the client renderer
 * (`WebSearchInlinePreview.tsx`). Keeping the schema shared
 * guarantees the LLM-facing description and the client-side type
 * inference for `useRenderTool` stay in lock-step.
 */

import { z } from "zod";

import type { WebSearchProviderId, WebSearchResult } from "./types";

// Caps surfaced to the LLM

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;

// LLM-facing args

export const webSearchArgsSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "Natural-language search query. Keep it focused and specific — " +
        "the same query you'd type into a search engine. 1–400 chars.",
    ),
  topK: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_K)
    .default(DEFAULT_TOP_K)
    .describe(
      `Number of results to return (1–${MAX_TOP_K}). Default ${DEFAULT_TOP_K}. ` +
        "Smaller values are cheaper in tokens.",
    ),
});

export type WebSearchArgs = z.infer<typeof webSearchArgsSchema>;

// Result envelope

/** Successful tool result. `provider` lets downstream consumers
 *  (admin run timeline, sub-agent prompts) see which upstream answered. */
export interface WebSearchOk {
  ok: true;
  provider: WebSearchProviderId;
  results: WebSearchResult[];
}

/** Error envelope mirroring `extract_dataset_by_sql` — every failure
 *  the LLM should be able to recognise has a stable string code. */
export interface WebSearchErr {
  ok: false;
  error:
    | "NO_PROVIDER"
    | "AUTH_MISSING"
    | "NOT_IMPLEMENTED"
    | "UPSTREAM_HTTP"
    | "UPSTREAM_TIMEOUT"
    | "INVALID_RESPONSE";
  message: string;
}

export type WebSearchResultEnvelope = WebSearchOk | WebSearchErr;
