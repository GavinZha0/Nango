"use client";

/**
 * WebSearchInlinePreview — chat-inline preview of a `web_search`
 * tool call. Renders a small status card AND writes the parsed
 * result into `outcomeStore` via a useEffect so the full card-list
 * also appears in the Outcomes panel. The LLM is unaware of this
 * bridge — it's a pure client-side rendering policy. Mirrors
 * `ChartPreviewCard`'s three-state shape. See
 * docs/data-visualization.md.
 */

import { ArrowUpRight, Globe, Loader2, AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, type ReactElement } from "react";

import type {
  WebSearchArgs,
  WebSearchResultEnvelope,
} from "@/lib/web-search/schema";
import { useOutcomeStore, type CardListItem } from "@/store/outcome-store";
import { useWorkspaceStore } from "@/store/workspace";

// props (matches CopilotKit v2 RenderToolProps shape)

export interface WebSearchPreviewProps {
  name: string;
  toolCallId: string;
  parameters: Partial<WebSearchArgs> | WebSearchArgs;
  status: "inProgress" | "executing" | "complete";
  result: string | undefined;
}

// component

export function WebSearchInlinePreview(
  props: WebSearchPreviewProps,
): ReactElement {
  const router = useRouter();
  const addOutcome = useOutcomeStore((s) => s.addOutcome);
  const select = useOutcomeStore((s) => s.select);

  // Parse once per result change — the useEffect and the render
  // path share the same Result reference, so we avoid double-parsing.
  const parsed: WebSearchResultEnvelope | null = useMemo(() => {
    if (props.status !== "complete" || !props.result) return null;
    try {
      return JSON.parse(props.result) as WebSearchResultEnvelope;
    } catch {
      return null;
    }
  }, [props.status, props.result]);

  // Idempotent on (toolCallId, parsed) — `addOutcome` is upsert
  // by id. Failed envelopes (`ok: false`) skip outcome creation;
  // the failure shows inline in the chat preview instead.
  useEffect(() => {
    if (!parsed || !parsed.ok) return;
    const args = props.parameters as WebSearchArgs;
    const ws = useWorkspaceStore.getState();
    // Citation contract: 1-based `index` + `sourceKind: 'web'` so
    // `[1]`/`[2]` chat citations line up with the numbered cards.
    // See docs/artifact-evolution.md.
    const cards: CardListItem[] = parsed.results.map((r, i) => ({
      index: i + 1,
      sourceKind: "web",
      ...(r.image ? { image: r.image } : {}),
      title: r.title,
      url: r.url,
      ...(tryDomain(r.url) ? { subtitle: tryDomain(r.url) } : {}),
      ...(r.snippet ? { snippet: r.snippet } : {}),
      ...(r.publishedAt ? { meta: r.publishedAt } : {}),
      ...(r.favicon ? { favicon: r.favicon } : {}),
    }));
    addOutcome({
      outcomeId: props.toolCallId,
      kind: "report",
      title: `Search: ${args.query}`,
      description: `${parsed.results.length} results · via ${parsed.provider}`,
      blocks: [{ kind: "card_list", cards }],
      agentId: ws.activeAgentId,
      threadId: ws.runtimeThreadId ?? null,
      runId: null,
      createdAt: Date.now(),
      // Show the result cards on arrival — the inner "Show N more"
      // toggle already keeps the outer card visually balanced with
      // chart neighbours, so default-folded is more friction than
      // signal.
      collapsed: false,
      savedArtifactId: null,
    });
  }, [parsed, props.toolCallId, props.parameters, addOutcome]);

  // render

  if (props.status === "inProgress") {
    const partial = props.parameters as Partial<WebSearchArgs>;
    return (
      <CardShell>
        <Globe className="size-4 animate-pulse text-muted-foreground" aria-hidden />
        <span className="text-sm text-muted-foreground">
          {partial.query ? `Searching for "${partial.query}"…` : "Searching the web…"}
        </span>
      </CardShell>
    );
  }

  const args = props.parameters as WebSearchArgs;

  if (props.status === "executing") {
    return (
      <CardShell>
        <Loader2 className="size-4 animate-spin text-blue-500" aria-hidden />
        <span className="text-sm font-medium">Searching for &quot;{args.query}&quot;…</span>
      </CardShell>
    );
  }

  // status === "complete"
  if (!parsed) {
    return (
      <CardShell>
        <AlertTriangle className="size-4 text-destructive" aria-hidden />
        <span className="text-sm font-medium text-destructive">
          Search response could not be parsed
        </span>
      </CardShell>
    );
  }
  if (!parsed.ok) {
    return (
      <CardShell>
        <AlertTriangle className="size-4 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive">Search failed</p>
          <p className="truncate text-xs text-muted-foreground" title={parsed.message}>
            {parsed.error}: {parsed.message}
          </p>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell>
      <Globe className="size-4 text-blue-500" aria-hidden />
      <button
        type="button"
        onClick={() => {
          router.push("/outcomes");
          select(props.toolCallId);
        }}
        className="inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
        aria-label={`View search "${args.query}" in Outcomes`}
      >
        Searched: &quot;{args.query}&quot; · {parsed.results.length} results
        <ArrowUpRight className="size-3" aria-hidden />
      </button>
    </CardShell>
  );
}

// shell

/** Single visual shell for every status. The red `AlertTriangle` icon
 *  and `text-destructive` headline already make failure unmistakable,
 *  so we deliberately keep the card's container neutral (no red
 *  background or border) to avoid double-signalling. */
function CardShell({
  children,
}: {
  children: React.ReactNode;
}): ReactElement {
  return (
    <div
      className="my-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-2"
    >
      {children}
    </div>
  );
}

// helpers

/** Best-effort domain extraction for the card's subtitle. Returns
 *  the empty string when the URL fails to parse so the subtitle
 *  spread above silently omits the field. */
function tryDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
