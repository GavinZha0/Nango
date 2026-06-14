"use client";

/**
 * StatsDashboard — fetches profile stats and renders 5 resource cards.
 */

import type { ReactNode } from "react";
import {
  Bot,
  BicepsFlexed,
  Plug,
  Terminal,
  Database,
  Loader2,
} from "lucide-react";
import useSWR from "swr";

import { ResourceStatsCard } from "./ResourceStatsCard";
import type { ProfileStatsResponse } from "@/app/api/profile/stats/route";

const fetcher = async (url: string): Promise<ProfileStatsResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json();
};

export function StatsDashboard(): ReactNode {
  const { data, isLoading, error } = useSWR<ProfileStatsResponse>(
    "/api/profile/stats",
    fetcher,
    { revalidateOnFocus: false },
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Failed to load resource stats.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      <ResourceStatsCard
        icon={Bot}
        label="Agents"
        total={data.agents.total}
        top={data.agents.top}
      />
      <ResourceStatsCard
        icon={BicepsFlexed}
        label="Skills"
        total={data.skills.total}
        top={data.skills.top}
      />
      <ResourceStatsCard
        icon={Plug}
        label="MCP"
        total={data.mcp.total}
        top={data.mcp.top}
      />
      <ResourceStatsCard
        icon={Terminal}
        label="SSH"
        total={data.ssh.total}
        top={data.ssh.top}
      />
      <ResourceStatsCard
        icon={Database}
        label="Datasource"
        total={data.database.total}
        top={data.database.top}
      />
    </div>
  );
}
