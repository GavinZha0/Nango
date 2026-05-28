"use client";

/**
 * DataSourceEditor — full-area form for creating / editing one
 * @see docs/data-sources.md §3
 */

import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Plug,
  Plus,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn } from "@/lib/utils";

// Match server-side DATA_SOURCE_IDS. Hard-coded here to avoid pulling
// the server module into the client bundle.
const PROVIDERS: ReadonlyArray<{ id: string; label: string; defaultPort: number }> = [
  { id: "postgres", label: "PostgreSQL", defaultPort: 5432 },
  { id: "mysql", label: "MySQL", defaultPort: 3306 },
  { id: "mariadb", label: "MariaDB", defaultPort: 3306 },
  { id: "vertica", label: "Vertica", defaultPort: 5433 },
];

const NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

// Types

interface DataSourceDetail {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  credentialId: string;
  host: string;
  port: number;
  database: string;
  params: Record<string, string>;
  readOnly: boolean;
  tableAllowlist: string[] | null;
  tableDenylist: string[];
}

interface CredentialOption {
  id: string;
  name: string;
  provider: string | null;
}

export interface DataSourceEditorProps {
  /** Existing id when editing; null when creating. */
  dataSourceId: string | null;
  /** Existing row when editing — fetched by the page wrapper. */
  initialDetail?: DataSourceDetail;
  onBack: () => void;
  onSaved: () => void;
}

// Param key/value editor

interface ParamRow {
  key: string;
  value: string;
}

function paramsToRows(p: Record<string, string>): ParamRow[] {
  return Object.entries(p).map(([key, value]) => ({ key, value }));
}

function rowsToParams(rows: ParamRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return out;
}

// Allow/deny list helpers

function parseTableList(raw: string): string[] {
  // Comma OR semicolon separators only — newlines / spaces are
  // preserved inside a token (SQL identifiers don't usually carry
  // them, but a permissive parser shouldn't silently slice on
  // whitespace either).
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatTableList(list: string[] | null): string {
  return list ? list.join(", ") : "";
}

// Component

export function DataSourceEditor({
  dataSourceId,
  initialDetail,
  onBack,
  onSaved,
}: DataSourceEditorProps): ReactNode {
  const isNew = dataSourceId === null;

  // Defaults for create.
  const defaultProvider = PROVIDERS[0];
  const [name, setName] = useState<string>(initialDetail?.name ?? "");
  const [description, setDescription] = useState<string>(initialDetail?.description ?? "");
  const [provider, setProvider] = useState<string>(
    initialDetail?.provider ?? defaultProvider.id,
  );
  const [credentialId, setCredentialId] = useState<string>(
    initialDetail?.credentialId ?? "",
  );
  const [host, setHost] = useState<string>(initialDetail?.host ?? "");
  const [port, setPort] = useState<string>(
    String(initialDetail?.port ?? defaultProvider.defaultPort),
  );
  const [database, setDatabase] = useState<string>(initialDetail?.database ?? "");
  const [paramRows, setParamRows] = useState<ParamRow[]>(
    initialDetail ? paramsToRows(initialDetail.params) : [],
  );
  const [readOnly, setReadOnly] = useState<boolean>(initialDetail?.readOnly ?? true);
  const [tableAllowlistText, setTableAllowlistText] = useState<string>(
    formatTableList(initialDetail?.tableAllowlist ?? null),
  );
  const [tableDenylistText, setTableDenylistText] = useState<string>(
    formatTableList(initialDetail?.tableDenylist ?? []),
  );
  const [credentials, setCredentials] = useState<CredentialOption[]>([]);
  const [saving, setSaving] = useState<boolean>(false);
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<
    | { ok: true; latencyMs: number }
    | { ok: false; error: string }
    | null
  >(null);

  // Credentials list — filter to provider on the client so the picker
  // only shows usable creds. Server enforces the same constraint.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/datasource-credentials");
        if (!cancelled && res.ok) {
          const data = (await res.json()) as CredentialOption[];
          setCredentials(data);
        }
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The credential picker lists ALL serviceType=datasource credentials
  // regardless of `credential.provider`.
  const credentialOptions = useMemo(
    () =>
      [...credentials].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [credentials],
  );

  // Auto-default the port when the user picks a different provider on create.
  function handleProviderChange(next: string): void {
    setProvider(next);
    const def = PROVIDERS.find((p) => p.id === next);
    if (def) setPort(String(def.defaultPort));
  }

  function addParam(): void {
    setParamRows((prev) => [...prev, { key: "", value: "" }]);
  }
  function updateParam(i: number, patch: Partial<ParamRow>): void {
    setParamRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeParam(i: number): void {
    setParamRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Validation

  function validateLocal(): string | null {
    if (!name.trim()) return "Name is required.";
    if (!NAME_RE.test(name)) {
      return "Name must start with a-z and contain only [a-z0-9_-] (max 63 chars).";
    }
    if (!credentialId) return "Credential is required.";
    if (!host.trim()) return "Host is required.";
    if (!database.trim()) return "Database is required.";
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      return "Port must be an integer between 1 and 65535.";
    }
    return null;
  }

  // Persist

  function buildPayload(forCreate: boolean): Record<string, unknown> {
    // Empty allowlist text → null = no restriction.
    const allowlistParsed = parseTableList(tableAllowlistText);
    const allowlist = allowlistParsed.length > 0 ? allowlistParsed : null;
    const denylist = parseTableList(tableDenylistText);
    const params = rowsToParams(paramRows);
    const base: Record<string, unknown> = {
      description: description.trim() || null,
      credentialId,
      host: host.trim(),
      port: Number(port),
      database: database.trim(),
      params,
      readOnly,
      tableAllowlist: allowlist,
      tableDenylist: denylist,
    };
    if (forCreate) {
      base.name = name;
    }
    // Provider is sent on both create AND update — it is now mutable.
    // Cache invalidation on provider change is deferred (a separate
    // "purge cache" admin action is on the roadmap); flipping
    // provider mid-life will leave stale Parquet snapshots that no
    // longer match the upstream dialect until the same `name` is
    // re-extracted.
    base.provider = provider;
    return base;
  }

  async function handleSave(): Promise<void> {
    const localErr = validateLocal();
    if (localErr) {
      setError(localErr);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const payload = buildPayload(isNew);
      const res = isNew
        ? await fetch("/api/data-sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/data-sources/${dataSourceId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; code?: string }
          | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm(): Promise<void> {
    if (!dataSourceId) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/data-sources/${dataSourceId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      setDeleteOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  async function handleTestConnection(): Promise<void> {
    // Two endpoints intentionally:
    //   - POST /api/data-sources/[id]/test-connection   — for saved rows
    //   - POST /api/data-sources/test-connection        — stateless,
    //     accepts the in-flight form payload (the New flow).
    // Validate locally first so we don't ship "host: ''" upstream.
    const localErr = validateLocal();
    if (localErr) {
      setTestResult({ ok: false, error: localErr });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = dataSourceId
        ? await fetch(`/api/data-sources/${dataSourceId}/test-connection`, {
            method: "POST",
          })
        : await fetch("/api/data-sources/test-connection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider,
              credentialId,
              host: host.trim(),
              port: Number(port),
              database: database.trim(),
              params: rowsToParams(paramRows),
            }),
          });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; latencyMs: number; error?: string; message?: string }
        | null;
      if (!res.ok) {
        setTestResult({
          ok: false,
          error: body?.message ?? body?.error ?? `HTTP ${res.status}`,
        });
      } else if (body?.ok) {
        setTestResult({ ok: true, latencyMs: body.latencyMs ?? 0 });
      } else {
        setTestResult({ ok: false, error: body?.error ?? "Unknown error" });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  // Render

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Back"
          className="h-7 w-7"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Plug className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">
          {isNew ? "New data source" : initialDetail?.name}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleTestConnection()}
            disabled={testing}
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">Test connection</span>
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving}
            className="h-8 gap-1.5"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
          {!isNew && (
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5 bg-primary text-destructive hover:bg-primary/80 hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={saving || deleting}
              title="Delete this data source (cannot be undone)"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete
            </Button>
          )}
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete data source</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete <strong>{initialDetail?.name ?? "this data source"}</strong>?
              Cached datasets produced by this source will be removed too. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {(error || testResult) && (
            <div className="space-y-2">
              {error && (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              {testResult && (
                <div
                  className={cn(
                    "flex items-center gap-2 rounded border px-3 py-2 text-xs",
                    testResult.ok
                      ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300"
                      : "border-destructive/40 bg-destructive/10 text-destructive",
                  )}
                >
                  {testResult.ok ? (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      <span>Connected (latency {testResult.latencyMs} ms)</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4" />
                      <span>{testResult.error}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Identity ─────────────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Identity
            </h3>
            <div className="space-y-2">
              <Label htmlFor="ds-name">Name</Label>
              <Input
                id="ds-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Lowercase letters, digits, _ and -. Cannot be changed later"
                disabled={!isNew}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ds-description">Description</Label>
              <Textarea
                id="ds-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder=""
              />
            </div>
          </section>

          {/* ── Connection ───────────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Connection
            </h3>
            {/*
             * Inline label + input rows (label fixed-width on the
             * left, input flexes to fill the rest). The fixed
             * `w-28` keeps every label edge aligned regardless of
             * text length so the form reads as a tidy table.
             */}
            <div className="flex items-center gap-3">
              <Label htmlFor="ds-provider" className="w-20 shrink-0">
                Provider
              </Label>
              <div className="flex-1">
                <Select
                  value={provider}
                  onValueChange={(v) => v && handleProviderChange(v)}
                >
                  <SelectTrigger id="ds-provider" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="ds-host" className="w-20 shrink-0">
                Host
              </Label>
              <Input
                id="ds-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="10.0.0.5"
                className="flex-1"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="ds-port" className="w-20 shrink-0">
                Port
              </Label>
              <Input
                id="ds-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="5432"
                className="flex-1"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="ds-database" className="w-20 shrink-0">
                Database
              </Label>
              <Input
                id="ds-database"
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder="sales"
                className="flex-1"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="ds-credential" className="w-20 shrink-0">
                Credential
              </Label>
              <div className="flex-1">
                <Select value={credentialId} onValueChange={(v) => setCredentialId(v ?? "")}>
                  <SelectTrigger id="ds-credential" className="w-full">
                    {/*
                     * Resolve the label from our own lookup. Radix's
                     * default SelectValue relies on a matching
                     * SelectItem being mounted; during the initial
                     * fetch (or if the saved credential's provider
                     * was changed elsewhere and no longer matches the
                     * filter) no SelectItem is rendered and the
                     * trigger would otherwise fall back to the raw
                     * uuid. Passing children to SelectValue overrides
                     * that fallback.
                     */}
                    <SelectValue placeholder="Select a credential">
                      {credentialId
                        ? (credentials.find((c) => c.id === credentialId)?.name
                          ?? "Unknown credential")
                        : null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {credentialOptions.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No data-source credentials. Create one in
                        Admin&nbsp;&rarr;&nbsp;Credentials.
                      </div>
                    ) : (
                      credentialOptions.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          <span>{c.name}</span>
                          {c.provider && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              ({c.provider})
                            </span>
                          )}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Connection parameters (optional)</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={addParam}
                  className="h-6 text-xs"
                >
                  <Plus className="h-3 w-3" />
                  <span className="ml-1">Add</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Driver-specific URL params (e.g. <code>timezone=UTC</code>,{" "}
                <code>sslmode=require</code>, <code>charset=utf8mb4</code>).
              </p>
              {paramRows.length > 0 && (
                <div className="space-y-2">
                  {paramRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={row.key}
                        onChange={(e) => updateParam(i, { key: e.target.value })}
                        placeholder="key"
                        className="flex-1"
                      />
                      <Input
                        value={row.value}
                        onChange={(e) => updateParam(i, { value: e.target.value })}
                        placeholder="value"
                        className="flex-1"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeParam(i)}
                        aria-label="Remove param"
                        className="h-7 w-7"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* ── Policy ──────────────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Access policy
            </h3>
            <div className="flex items-start gap-2">
              <Checkbox
                id="ds-readonly"
                checked={readOnly}
                onCheckedChange={(v) => setReadOnly(v === true)}
              />
              <div className="space-y-0.5">
                <Label htmlFor="ds-readonly" className="cursor-pointer">
                  Read-only
                </Label>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ds-allowlist">Allowlist (optional)</Label>
              <Textarea
                id="ds-allowlist"
                value={tableAllowlistText}
                onChange={(e) => setTableAllowlistText(e.target.value)}
                rows={2}
                placeholder="Separate table names with comma or semicolon."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ds-denylist">Denylist (optional)</Label>
              <Textarea
                id="ds-denylist"
                value={tableDenylistText}
                onChange={(e) => setTableDenylistText(e.target.value)}
                rows={2}
                placeholder="Separate table names with comma or semicolon."
              />
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
