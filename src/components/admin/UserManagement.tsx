"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { alphabeticCompare } from "@/lib/utils/sort";
import { SortableHeader, useTableSort } from "@/components/admin/SortableHeader";

interface UserRowWithDate extends UserRow {
  createdAt: string | Date;
}

type UserSortColumn = "name" | "role" | "status";

export interface UserManagementProps {
  createOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function UserManagement({
  createOpen: controlledCreateOpen,
  onOpenChange: controlledOnOpenChange,
}: UserManagementProps = {}): ReactNode {
  const tz = useDisplayTimezone();
  const [users, setUsers] = useState<UserRowWithDate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalCreateOpen, setInternalCreateOpen] = useState(false);
  const [revision, setRevision] = useState(0);

  const isControlled = controlledCreateOpen !== undefined;
  const createOpen = isControlled ? controlledCreateOpen : internalCreateOpen;
  const setCreateOpen = isControlled ? (controlledOnOpenChange ?? (() => {})) : setInternalCreateOpen;

  const { sortColumn, sortDirection, handleSort } = useTableSort<UserSortColumn>("name");

  // Fetch whenever revision changes
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      // Custom GET /api/admin/users — filters out soft-deleted users.
      // Fetches all active users for in-memory display and client-side sorting.
      try {
        const res = await fetch("/api/admin/users");
        if (res.ok) {
          const body = (await res.json()) as { users: UserRowWithDate[] };
          if (!cancelled) {
            setUsers(body.users);
          }
        } else {
          if (!cancelled) {
            setError(`Failed to load users (HTTP ${res.status})`);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load users");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [revision]);

  function refresh() {
    setRevision((r) => r + 1);
  }

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      let result = 0;
      if (sortColumn === "name") {
        result = alphabeticCompare(a.name, b.name);
      } else if (sortColumn === "role") {
        result = alphabeticCompare(a.role, b.role);
      } else if (sortColumn === "status") {
        const statusA = a.banned ? "Banned" : "Active";
        const statusB = b.banned ? "Banned" : "Active";
        result = alphabeticCompare(statusA, statusB);
      }
      if (result === 0) {
        result = alphabeticCompare(a.name, b.name);
      }
      return sortDirection === "asc" ? result : -result;
    });
  }, [users, sortColumn, sortDirection]);

  return (
    <div className="flex flex-col gap-4">
      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader
                label="Name"
                column="name"
                currentColumn={sortColumn}
                currentDirection={sortDirection}
                onSort={handleSort}
              />
              <TableHead>Email</TableHead>
              <TableHead>Org</TableHead>
              <SortableHeader
                label="Role"
                column="role"
                currentColumn={sortColumn}
                currentDirection={sortDirection}
                onSort={handleSort}
              />
              <SortableHeader
                label="Status"
                column="status"
                currentColumn={sortColumn}
                currentDirection={sortDirection}
                onSort={handleSort}
              />
              <TableHead>Last Active</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-destructive">
                  {error}
                </TableCell>
              </TableRow>
            ) : sortedUsers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No users found.
                </TableCell>
              </TableRow>
            ) : (
              sortedUsers.map((user) => (
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

      <UserFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={refresh}
      />
    </div>
  );
}
