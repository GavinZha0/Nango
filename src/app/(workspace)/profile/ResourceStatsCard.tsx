"use client";

/**
 * ResourceStatsCard — displays a resource type's total count and
 * top-5 most-used items (last 30 days) in a compact card.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface TopItem {
  id: string;
  name: string;
  count: number;
}

interface ResourceStatsCardProps {
  icon: LucideIcon;
  label: string;
  total: number;
  top: TopItem[];
}

export function ResourceStatsCard({
  icon: Icon,
  label,
  total,
  top,
}: ResourceStatsCardProps): ReactNode {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Icon className="h-3.5 w-3.5 text-primary" />
          </div>
          <CardTitle className="flex-1">{label}</CardTitle>
          <span className="text-lg font-semibold tabular-nums">{total}</span>
        </div>
      </CardHeader>

      <CardContent>
        {top.length > 0 ? (
          <ul className="space-y-1">
            {top.map((item, i) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="truncate text-muted-foreground">
                  <span className="mr-1.5 inline-block w-3 text-right text-[10px] text-muted-foreground/60">
                    {i + 1}
                  </span>
                  {item.name}
                </span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {item.count}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No usage data yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
