"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CredentialFormDialog, type CredentialRow } from "@/components/admin/CredentialFormDialog";
import { Plus, Trash2, KeyRound } from "lucide-react";

// Type label map

const TYPE_LABELS: Record<string, string> = {
  api_key: "API Key",
  bearer_token: "Bearer Token",
  certificate: "Certificate",
  basic_auth: "Basic Auth",
  oauth_client: "OAuth Client",
  keypair: "Key Pair",
};

const SERVICE_TYPE_LABELS: Record<string, string> = {
  llm: "LLM",
  search: "Search",
  agent: "Agent",
  observability: "Observability",
  api: "API",
  other: "Other",
};

// Delete button with confirmation

interface DeleteButtonProps {
  row: CredentialRow;
  onRefresh: () => void;
}

function DeleteButton({ row, onRefresh }: DeleteButtonProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete() {
    setWorking(true);
    setError("");
    const res = await fetch(`/api/admin/credentials/${row.id}`, { method: "DELETE" });
    setWorking(false);
    if (!res.ok) {
      if (res.status === 409) {
        // Envelope: `{ ok:false, code:"CONFLICT", message, requestId,
        // details: { usages } }`. `error` fallback covers any
        // un-migrated route.
        const body = await res.json().catch(() => null);
        setError(
          body?.message
            ?? body?.error
            ?? "This credential is in use and cannot be deleted.",
        );
      } else {
        setError("Delete failed — please try again.");
      }
      return;
    }
    setOpen(false);
    onRefresh();
  }

  return (
    <>
      <button
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-accent"
        onClick={() => { setError(""); setOpen(true); }}
        aria-label="Delete"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete credential</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete <strong>{row.name}</strong>? Any services using this
              credential will lose access. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={working}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {working ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Enabled switch

interface EnabledSwitchProps {
  row: CredentialRow;
  onRefresh: () => void;
}

/**
 * Tolerant boolean coercion. The wire format should be a JS boolean,
 * but a defence-in-depth guard against stringified booleans
 * ("true"/"false"/"t"/"f") avoids a class of stale-data /
 * driver-quirk bugs where the Switch would otherwise read a non-empty
 * string as truthy and refuse to ever flip to "off". Returns false
 * for null/undefined/anything unrecognised — safer default for a
 * credential gate.
 */
function coerceEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "true" || v === "t") return true;
    if (v === "false" || v === "f") return false;
  }
  return false;
}

function EnabledSwitch({ row, onRefresh }: EnabledSwitchProps): ReactNode {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEnabled = coerceEnabled(row.enabled);

  async function toggle() {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/credentials/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !isEnabled }),
      });
      if (!res.ok) {
        // Surface non-2xx so the user knows the toggle didn't actually
        // land — without this, the Switch silently snaps back on
        // `onRefresh()` and looks like "click did nothing".
        const detail = await res
          .json()
          .then((body: { message?: string }) => body?.message)
          .catch(() => res.statusText);
        setError(detail ?? `HTTP ${res.status}`);
        return;
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Switch
        checked={isEnabled}
        onCheckedChange={toggle}
        disabled={working}
        aria-label={isEnabled ? "Disable credential" : "Enable credential"}
      />
      {error && (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// Main table

export function CredentialManagement(): ReactNode {
  const [rows, setRows] = useState<CredentialRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CredentialRow | undefined>(undefined);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const res = await fetch("/api/admin/credentials");
      if (!cancelled && res.ok) {
        const data = (await res.json()) as CredentialRow[];
        // Normalise `enabled` at the boundary so every downstream
        // render path (Switch, row opacity, edit dialog) sees a real
        // boolean. The server-side route already returns booleans,
        // but coerceEnabled is a defensive belt that fixes a Switch
        // that's stuck "on" should anything ever leak a "t"/"f"
        // string through this column.
        setRows(
          data.map((r) => ({ ...r, enabled: coerceEnabled(r.enabled) })),
        );
      }
      if (!cancelled) setLoading(false);
    }

    void load();
    return () => { cancelled = true; };
  }, [revision]);

  function refresh() { setRevision((r) => r + 1); }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <KeyRound className="h-6 w-6 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <h1 className="text-xl font-bold tracking-tight">Credentials</h1>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          New Credential
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Service</TableHead>
              <TableHead>Credential Type</TableHead>
              <TableHead>Secret Key</TableHead>
              <TableHead>Endpoints</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                  No credentials yet. Click <strong>New Credential</strong> to add one.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id} className={row.enabled ? "" : "opacity-40"}>
                  {/* Name — click to edit */}
                  <TableCell>
                    <button
                      onClick={() => setEditing(row)}
                      className="font-medium underline-offset-2 hover:underline hover:text-foreground text-left"
                    >
                      {row.name}
                    </button>
                  </TableCell>

                  <TableCell className="text-muted-foreground">
                    {row.provider ?? "—"}
                  </TableCell>

                  <TableCell className="text-muted-foreground">
                    {SERVICE_TYPE_LABELS[row.serviceType] ?? row.serviceType ?? "—"}
                  </TableCell>

                  <TableCell className="text-muted-foreground">
                    {TYPE_LABELS[row.type] ?? row.type}
                  </TableCell>

                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {row.metadata?.keyPreview ?? "—"}
                  </TableCell>

                  <TableCell className="max-w-xs">
                    {row.restUrl || row.aguiUrl ? (
                      <div className="flex flex-col gap-0.5">
                        {row.restUrl && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <span className="shrink-0 font-medium text-foreground/60">REST</span>
                            <span className="truncate" title={row.restUrl}>{row.restUrl}</span>
                          </span>
                        )}
                        {row.aguiUrl && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <span className="shrink-0 font-medium text-foreground/60">AGUI</span>
                            <span className="truncate" title={row.aguiUrl}>{row.aguiUrl}</span>
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  <TableCell className="text-center text-sm text-muted-foreground">
                    {row.usageCount > 0 ? row.usageCount : "—"}
                  </TableCell>

                  <TableCell>
                    <EnabledSwitch row={row} onRefresh={refresh} />
                  </TableCell>

                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(row.updatedAt).toLocaleDateString()}
                  </TableCell>

                  <TableCell>
                    <DeleteButton row={row} onRefresh={refresh} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create dialog */}
      <CredentialFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={refresh}
      />

      {/* Edit dialog */}
      <CredentialFormDialog
        open={editing !== undefined}
        onOpenChange={(open) => { if (!open) setEditing(undefined); }}
        onSuccess={refresh}
        editing={editing}
      />
    </div>
  );
}
