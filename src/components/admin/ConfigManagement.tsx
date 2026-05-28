"use client";

/**
 * ConfigManagement — admin config management with grouped display.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Settings,
  X,
} from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// Types

interface ConfigRow {
  id: string;
  key: string;
  value: string;
  valueType: string;
  options: string[] | null;
  prevValue: string | null;
  description: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// Editable value cell

function ValueCell({
  row,
  onSave,
}: {
  row: ConfigRow;
  onSave: (key: string, value: string) => Promise<void>;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.value);
  const [saving, setSaving] = useState(false);

  const handleSave = async (): Promise<void> => {
    if (draft === row.value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    await onSave(row.key, draft);
    setSaving(false);
    setEditing(false);
  };

  const handleCancel = (): void => {
    setDraft(row.value);
    setEditing(false);
  };

  // Enum: render select dropdown (no edit mode needed)
  if (row.options && row.options.length > 0) {
    return (
      <Select value={row.value} onValueChange={(v) => { if (v) void onSave(row.key, v); }}>
        <SelectTrigger className="h-7 w-48 text-xs font-mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {row.options.map((opt) => (
            <SelectItem key={opt} value={opt} className="text-xs font-mono">
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  // Boolean: render switch
  if (row.valueType === "boolean") {
    return (
      <Switch
        checked={row.value === "true" || row.value === "1"}
        onCheckedChange={(checked) => void onSave(row.key, String(checked))}
      />
    );
  }

  // Default: inline text editing
  if (!editing) {
    return (
      <div className="group flex items-center gap-1.5">
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
          {row.value}
        </code>
        <button
          type="button"
          onClick={() => { setDraft(row.value); setEditing(true); }}
          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted"
          aria-label={`Edit ${row.key}`}
        >
          <Pencil className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        className="h-7 w-40 font-mono text-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSave();
          if (e.key === "Escape") handleCancel();
        }}
        autoFocus
      />
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => void handleSave()}
        disabled={saving}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={handleCancel}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

// Group header

function GroupHeader({
  group,
  count,
  open,
  onToggle,
}: {
  group: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 border-b bg-muted/40 px-4 py-2 text-left hover:bg-muted/60"
    >
      <ChevronRight
        className={cn("h-3.5 w-3.5 shrink-0 transition-transform text-muted-foreground", open && "rotate-90")}
      />
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {group}
      </span>
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
        {count}
      </span>
    </button>
  );
}

// Main component

export function ConfigManagement(): ReactNode {
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: ConfigRow[] };
      setRows(data.items);
      // All groups collapsed by default; user expands on demand.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init(): Promise<void> {
      try {
        const res = await fetch("/api/admin/config");
        if (!cancelled && res.ok) {
          const data = (await res.json()) as { items: ConfigRow[] };
          setRows(data.items);
        }
      } catch {
        if (!cancelled) setError("Failed to load config");
      }
      if (!cancelled) setLoading(false);
    }
    void init();
    return () => { cancelled = true; };
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, ConfigRow[]>();
    for (const row of rows) {
      const group = row.key.split(".")[0] ?? "other";
      const list = map.get(group) ?? [];
      list.push(row);
      map.set(group, list);
    }
    return map;
  }, [rows]);

  const toggleGroup = (group: string): void => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const handleSave = async (key: string, value: string): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/config/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        alert(body.message ?? `Save failed (${res.status})`);
        return;
      }
      // Update local state to reflect the change.
      setRows((prev) =>
        prev.map((r) => (r.key === key ? { ...r, prevValue: r.value, value, updatedAt: new Date().toISOString() } : r)),
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Save failed");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Settings className="h-6 w-6 text-muted-foreground" />
        <div className="flex-1">
          <h1 className="text-xl font-bold tracking-tight">Configuration</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} parameters across {grouped.size} groups
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          className="gap-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Grouped config table */}
      <div className="rounded-xl border bg-card overflow-hidden">
        {[...grouped.entries()].map(([group, items]) => (
          <div key={group}>
            <GroupHeader
              group={group}
              count={items.length}
              open={openGroups.has(group)}
              onToggle={() => toggleGroup(group)}
            />
            {openGroups.has(group) && (
              <Table>
                <TableHeader>
                  <TableRow className="text-[11px]">
                    <TableHead className="w-[30%]">Key</TableHead>
                    <TableHead className="w-[7%]">Type</TableHead>
                    <TableHead className="w-[22%]">Value</TableHead>
                    <TableHead className="w-[16%]">Previous</TableHead>
                    <TableHead className="w-[25%]">Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((row) => (
                    <TableRow key={row.key} className="text-xs">
                      <TableCell className="font-mono font-medium align-top py-2.5">
                        {row.key}
                      </TableCell>
                      <TableCell className="align-top py-2.5">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {row.options ? "enum" : row.valueType}
                        </span>
                      </TableCell>
                      <TableCell className="align-top py-2.5">
                        <ValueCell row={row} onSave={handleSave} />
                      </TableCell>
                      <TableCell className="align-top py-2.5 font-mono text-[11px] text-muted-foreground">
                        {row.prevValue !== null && row.prevValue !== row.value
                          ? row.prevValue
                          : "—"}
                      </TableCell>
                      <TableCell className="align-top py-2.5 text-[11px] text-muted-foreground">
                        {row.description}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
