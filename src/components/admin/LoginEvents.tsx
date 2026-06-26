"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTimestamp } from "@/components/admin/format";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";

interface LoginEventRow {
  id: number;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  eventType: string;
  ipAddress: string | null;
  userAgent: string | null;
  detail: string | null;
  createdAt: string;
}

const PAGE_SIZE = 20;

const EVENT_BADGE: Record<string, { label: string; variant: "default" | "destructive" | "secondary" }> = {
  sign_in: { label: "Sign In", variant: "default" },
  sign_in_failed: { label: "Failed", variant: "destructive" },
  sign_out: { label: "Sign Out", variant: "secondary" },
};

function truncateUa(ua: string, max = 60): string {
  return ua.length > max ? ua.slice(0, max) + "…" : ua;
}

interface FetchParams {
  offset: number;
  revision: number;
}

export function LoginEvents(): ReactNode {
  const tz = useDisplayTimezone();
  const [events, setEvents] = useState<LoginEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [params, setParams] = useState<FetchParams>({ offset: 0, revision: 0 });

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setLoading(true);
      const url = new URL("/api/admin/login-events", window.location.origin);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(params.offset));
      try {
        const res = await fetch(url.toString(), { credentials: "include" });
        if (res.ok) {
          const body = (await res.json()) as { events: LoginEventRow[]; total: number };
          if (!cancelled) {
            setEvents(body.events);
            setTotal(body.total);
          }
        }
      } catch {
        /* swallowed */
      }
      if (!cancelled) setLoading(false);
    }

    void load();
    return () => { cancelled = true; };
  }, [params]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(params.offset / PAGE_SIZE) + 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Client</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No login events yet.
                </TableCell>
              </TableRow>
            ) : (
              events.map((ev) => {
                const badge = EVENT_BADGE[ev.eventType] ?? { label: ev.eventType, variant: "secondary" as const };
                return (
                  <TableRow key={ev.id}>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {formatTimestamp(ev.createdAt, tz)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{ev.userName ?? "—"}</span>
                        <span className="text-xs text-muted-foreground">{ev.userEmail ?? ""}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {ev.ipAddress ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-xs truncate" title={ev.userAgent ?? undefined}>
                      {ev.userAgent ? truncateUa(ev.userAgent) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {params.offset + 1}–{Math.min(params.offset + PAGE_SIZE, total)} of {total} events
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={params.offset === 0}
              onClick={() => setParams((p) => ({ ...p, offset: Math.max(0, p.offset - PAGE_SIZE) }))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={() => setParams((p) => ({ ...p, offset: p.offset + PAGE_SIZE }))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
