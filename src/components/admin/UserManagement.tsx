"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserFormDialog } from "@/components/admin/UserFormDialog";
import {
  RoleBadge,
  StatusBadge,
  UserActions,
  type UserRow,
} from "@/components/admin/UserActionMenu";
import { formatTimestamp } from "@/components/admin/format";
import { useDisplayTimezone } from "@/hooks/useDisplayTimezone";
import { UserPlus, Search } from "lucide-react";

interface UserRowWithDate extends UserRow {
  createdAt: Date;
}

const PAGE_SIZE = 20;

interface FetchParams {
  search: string;
  offset: number;
  /** Increment this to force a refresh without changing other params */
  revision: number;
}

export function UserManagement(): ReactNode {
  const tz = useDisplayTimezone();
  const [users, setUsers] = useState<UserRowWithDate[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [rawSearch, setRawSearch] = useState("");

  // Single source of truth for what is currently fetched
  const [params, setParams] = useState<FetchParams>({ search: "", offset: 0, revision: 0 });

  // Debounce: when rawSearch changes, wait 300 ms then update params (reset offset)
  useEffect(() => {
    const id = setTimeout(() => {
      setParams((p) => ({ ...p, search: rawSearch, offset: 0 }));
    }, 300);
    return () => clearTimeout(id);
  }, [rawSearch]);

  // Fetch whenever params change
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      // Custom GET /api/admin/users — filters out soft-deleted users
      // (better-auth's admin.listUsers returns them too).
      const url = new URL("/api/admin/users", window.location.origin);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(params.offset));
      if (params.search) url.searchParams.set("search", params.search);
      try {
        const res = await fetch(url.toString(), { credentials: "include" });
        if (res.ok) {
          const body = (await res.json()) as { users: UserRowWithDate[]; total: number };
          if (!cancelled) {
            setUsers(body.users);
            setTotal(body.total);
          }
        }
      } catch {
        /* swallowed; UI shows empty state */
      }
      if (!cancelled) setLoading(false);
    }

    void load();
    return () => { cancelled = true; };
  }, [params]);

  function refresh() {
    setParams((p) => ({ ...p, revision: p.revision + 1 }));
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(params.offset / PAGE_SIZE) + 1;

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name..."
            value={rawSearch}
            onChange={(e) => setRawSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <UserPlus className="h-4 w-4" />
          New User
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Org</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Active</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No users found.
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                  <TableCell className="text-muted-foreground">{user.org ?? "—"}</TableCell>
                  <TableCell>
                    <RoleBadge user={user} onRefresh={refresh} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge user={user} onRefresh={refresh} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {user.lastActiveAt ? formatTimestamp(user.lastActiveAt, tz) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatTimestamp(user.createdAt, tz)}
                  </TableCell>
                  <TableCell>
                    <UserActions user={user} onRefresh={refresh} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {params.offset + 1}–{Math.min(params.offset + PAGE_SIZE, total)} of {total} users
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

      <UserFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={refresh}
      />
    </div>
  );
}
