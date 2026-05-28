"use client";

/**
 * External agent detail page — read-only view of an agno / mastra /
 * dify entity surfaced by the workspace store.
 *
 * Route shape: `/agent/external/<credentialId>/<agentId>`
 * The pair `(credentialId, agentId)` is the entity's identity within
 * Nango (matches `agentKey(credentialId, id)` used elsewhere). Using
 * both in the URL means deep-links survive across multi-credential
 * setups where two upstreams happen to share an agent name.
 *
 * State source: read from the workspace store rather than fetching
 * — the store is already populated by `WorkspaceProvider` on app
 * mount, and the detail page should reflect the same data the list
 * panel shows. A Refresh button inside the detail view pulls fresh
 * data into the store when the user wants it.
 */

import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ExternalAgentDetailView } from "@/components/main-panels/ExternalAgentDetailView";
import type { EntityDescriptor } from "@/lib/backends/types";
import { useWorkspaceStore } from "@/store/workspace";

export default function ExternalAgentDetailPage(): ReactNode {
  const router = useRouter();
  const { credentialId, agentId } = useParams<{ credentialId: string; agentId: string }>();
  const decodedAgentId: string = decodeURIComponent(agentId);

  const { agents, teams, workflows, agentsLoaded } = useWorkspaceStore();

  // Locate the entity across all three kinds. Listing groups (agents
  // / teams / workflows) are split for cheap UI rendering; for a
  // detail page we just need a single lookup.
  const entity: EntityDescriptor | undefined = useMemo(() => {
    const all: EntityDescriptor[] = [...agents, ...teams, ...workflows];
    return all.find((e) => e.credentialId === credentialId && e.id === decodedAgentId);
  }, [agents, teams, workflows, credentialId, decodedAgentId]);

  if (entity) {
    return <ExternalAgentDetailView entity={entity} />;
  }

  // Either the store hasn't loaded yet, or the entity was removed
  // upstream (deleted, hidden, etc.). Show a friendly empty state
  // with a back action — the loading vs. not-found distinction is
  // surfaced through `agentsLoaded`.
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => router.push("/agent")}
          aria-label="Back to agent list"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-semibold">Agent not found</span>
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="max-w-md text-center text-sm text-muted-foreground">
          {agentsLoaded
            ? "This external agent isn't in the current workspace anymore. It may have been removed or hidden upstream — refresh the agent list to verify."
            : "Loading…"}
        </div>
      </div>
    </div>
  );
}
