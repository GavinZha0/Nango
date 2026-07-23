"use client";

/**
 * ContentSafetyTable — Unified Single-Table Component for Safety Policies.
 *
 * Placed in the lower half of the right column (60% width) in Guardrail Console.
 * Directly renders all regex and keyword_list safety policies in a clean unified table,
 * matching the visual structure of ToolRiskTable.
 */

import { useState } from "react";
import { ShieldPlus, Plus, Trash2, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";

export interface SafetyPolicyItem {
  id?: number;
  name?: string;
  displayName: string;
  description?: string | null;
  category:
    | "input_injection"
    | "output_redaction"
    | "secret_leak"
    | "topic_guard"
    | "model_eval"
    | "input_blacklist"
    | "output_blacklist";
  policyType: "regex" | "model_eval" | "keyword_list";
  action: "redact" | "block" | "warn";
  severity: "low" | "medium" | "high" | "critical";
  scope: "global" | "input" | "output";
  enabled: boolean;
  policyConfig?: Record<string, unknown>;
}

interface ContentSafetyTableProps {
  policies: SafetyPolicyItem[];
  onSavePolicy?: (policy: SafetyPolicyItem) => Promise<void>;
  onDeletePolicy?: (policyId: number) => Promise<void>;
}

const isBlacklistCategory = (cat?: string) =>
  cat === "input_blacklist" || cat === "output_blacklist";

export function ContentSafetyTable({
  policies,
  onSavePolicy,
  onDeletePolicy,
}: ContentSafetyTableProps) {
  const [editingPolicy, setEditingPolicy] = useState<Partial<SafetyPolicyItem> | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingPolicy, setDeletingPolicy] = useState<SafetyPolicyItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleCreateNew = () => {
    setEditingPolicy({
      displayName: "",
      category: "input_injection",
      policyType: "regex",
      action: "block",
      severity: "medium",
      scope: "input",
      enabled: true,
      policyConfig: { pattern: "" },
    });
  };

  const handleSave = async () => {
    if (!editingPolicy?.displayName || !onSavePolicy) return;
    setSaving(true);
    try {
      const cat = editingPolicy.category ?? "input_injection";
      const isBlacklist = isBlacklistCategory(cat);
      const policyType = isBlacklist ? "keyword_list" : editingPolicy.policyType ?? "regex";
      const scope = cat.startsWith("input") ? "input" : cat.startsWith("output") ? "output" : "global";

      await onSavePolicy({
        id: editingPolicy.id,
        name: editingPolicy.name && editingPolicy.name.trim() ? editingPolicy.name : undefined,
        displayName: editingPolicy.displayName,
        description: editingPolicy.description || undefined,
        category: cat,
        policyType,
        action: editingPolicy.action ?? "block",
        severity: editingPolicy.severity ?? "medium",
        scope,
        enabled: editingPolicy.enabled ?? true,
        policyConfig: editingPolicy.policyConfig ?? {},
      });
      setEditingPolicy(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = (policy: SafetyPolicyItem) => {
    setDeletingPolicy(policy);
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingPolicy?.id || !onDeletePolicy) return;
    setDeleting(true);
    try {
      await onDeletePolicy(deletingPolicy.id);
      setDeleteConfirmOpen(false);
      setDeletingPolicy(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header Bar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b bg-muted/20 px-3 py-1 mb-1.5 rounded-t-md">
        <div className="flex items-center gap-2">
          <ShieldPlus className="h-4 w-4 text-primary" />
          <span className="text-xs font-semibold text-foreground">Safety Policies</span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
            {policies.filter((p) => p.enabled).length}/{policies.length}
          </Badge>
        </div>

        <Button size="sm" variant="outline" className="h-6.5 text-[11px] gap-1 px-2" onClick={handleCreateNew}>
          <Plus className="h-3 w-3" />
          Add Policy
        </Button>
      </div>

      {/* Table Container */}
      <div className="flex-1 overflow-auto rounded-md border bg-background/50">
        <Table>
          <TableHeader className="bg-muted/40 sticky top-0">
            <TableRow className="h-7 border-b">
              <TableHead className="text-[11px] font-semibold py-1">Policy Name</TableHead>
              <TableHead className="text-[11px] font-semibold py-1">Category</TableHead>
              <TableHead className="text-[11px] font-semibold py-1">Action</TableHead>
              <TableHead className="text-[11px] font-semibold py-1">Severity</TableHead>
              <TableHead className="text-[11px] font-semibold py-1">Status</TableHead>
              <TableHead className="text-[11px] font-semibold text-right py-1">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">
                  No safety policies configured
                </TableCell>
              </TableRow>
            ) : (
              policies.map((p) => (
                <TableRow key={p.id ?? p.name} className="h-8 hover:bg-muted/30">
                  <TableCell className="text-xs font-medium py-0.5">
                    <div className="flex flex-col">
                      <span className="font-semibold text-foreground">{p.displayName}</span>
                      <span className="text-[9px] text-muted-foreground font-mono">{p.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="py-0.5 text-xs text-muted-foreground font-mono">
                    {p.category}
                  </TableCell>
                  <TableCell className="py-0.5 text-xs font-medium capitalize">
                    <span
                      className={cn(
                        p.action === "block"
                          ? "text-red-600 dark:text-red-400 font-semibold"
                          : "text-foreground",
                      )}
                    >
                      {p.action}
                    </span>
                  </TableCell>
                  <TableCell className="py-0.5 text-xs text-muted-foreground capitalize">
                    {p.severity}
                  </TableCell>
                  <TableCell className="py-0.5">
                    <Switch
                      checked={p.enabled}
                      onCheckedChange={(checked) =>
                        onSavePolicy && onSavePolicy({ ...p, enabled: checked })
                      }
                      className="scale-75"
                    />
                  </TableCell>
                  <TableCell className="text-right py-0.5">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5"
                        onClick={() => setEditingPolicy({ ...p })}
                      >
                        <SquarePen className="h-2.5 w-2.5" />
                      </Button>
                      {p.id && onDeletePolicy && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-destructive"
                          onClick={() => handleDeleteClick(p)}
                        >
                          <Trash2 className="h-2.5 w-2.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmDialog
        title="Delete safety policy"
        description={
          <span>
            Are you sure you want to delete the safety policy{" "}
            <strong className="font-mono">{deletingPolicy?.displayName}</strong>? This action cannot be undone.
          </span>
        }
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        onConfirm={handleDeleteConfirm}
        deleting={deleting}
      />

      {/* Policy Edit / Create Modal */}
      <Dialog open={!!editingPolicy} onOpenChange={(open) => !open && setEditingPolicy(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {editingPolicy?.id ? "Edit Safety Policy" : "Create Safety Policy"}
            </DialogTitle>
          </DialogHeader>

          {editingPolicy && (
            <div className="space-y-3.5 py-1 text-xs">
              <div className="space-y-1">
                <Label>Display Name</Label>
                <Input
                  value={editingPolicy.displayName ?? ""}
                  onChange={(e) => setEditingPolicy({ ...editingPolicy, displayName: e.target.value })}
                  placeholder="e.g. Sensitive SSN Redaction"
                  className="h-8 text-xs"
                />
              </div>

              <div className="space-y-1">
                <Label>Category</Label>
                <Select
                  value={editingPolicy.category}
                  items={[
                    { value: "input_injection", label: "input_injection (Prompt Injection Guard)" },
                    { value: "output_redaction", label: "output_redaction (Output PII Masking)" },
                    { value: "secret_leak", label: "secret_leak (API Key Leak Guard)" },
                    { value: "topic_guard", label: "topic_guard (Topic Compliance Guard)" },
                    { value: "input_blacklist", label: "input_blacklist (Input Keyword Blacklist)" },
                    { value: "output_blacklist", label: "output_blacklist (Output Keyword Blacklist)" },
                  ]}
                  onValueChange={(val: string | null) => {
                    if (!val) return;
                    const catVal = val as SafetyPolicyItem["category"];
                    const isBlacklist = isBlacklistCategory(catVal);
                    setEditingPolicy({
                      ...editingPolicy,
                      category: catVal,
                      policyType: isBlacklist ? "keyword_list" : "regex",
                      scope: catVal.startsWith("input") ? "input" : catVal.startsWith("output") ? "output" : "global",
                    });
                  }}
                >
                  <SelectTrigger className="w-full h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="input_injection">input_injection (Prompt Injection Guard)</SelectItem>
                    <SelectItem value="output_redaction">output_redaction (Output PII Masking)</SelectItem>
                    <SelectItem value="secret_leak">secret_leak (API Key Leak Guard)</SelectItem>
                    <SelectItem value="topic_guard">topic_guard (Topic Compliance Guard)</SelectItem>
                    <SelectItem value="input_blacklist">input_blacklist (Input Keyword Blacklist)</SelectItem>
                    <SelectItem value="output_blacklist">output_blacklist (Output Keyword Blacklist)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>Action</Label>
                <Select
                  value={editingPolicy.action}
                  items={[
                    { value: "redact", label: "redact (Mask & Replace)" },
                    { value: "block", label: "block (Block & Alarm)" },
                    { value: "warn", label: "warn (Log Warning Only)" },
                  ]}
                  onValueChange={(val: string | null) =>
                    val && setEditingPolicy({
                      ...editingPolicy,
                      action: val as SafetyPolicyItem["action"],
                    })
                  }
                >
                  <SelectTrigger className="w-full h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="redact">redact (Mask & Replace)</SelectItem>
                    <SelectItem value="block">block (Block & Alarm)</SelectItem>
                    <SelectItem value="warn">warn (Log Warning Only)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {isBlacklistCategory(editingPolicy.category) ? (
                <div className="space-y-1 border-t pt-2">
                  <Label>Keyword List (Comma-separated)</Label>
                  <Input
                    value={(editingPolicy.policyConfig?.keywords as string) ?? ""}
                    onChange={(e) =>
                      setEditingPolicy({
                        ...editingPolicy,
                        policyConfig: {
                          ...editingPolicy.policyConfig,
                          keywords: e.target.value,
                        },
                      })
                    }
                    placeholder="e.g. prohibited_word1, prohibited_word2"
                    className="h-8 text-xs font-mono"
                  />
                </div>
              ) : (
                <div className="space-y-1 border-t pt-2">
                  <Label>Regex Pattern</Label>
                  <Input
                    value={(editingPolicy.policyConfig?.pattern as string) ?? ""}
                    onChange={(e) =>
                      setEditingPolicy({
                        ...editingPolicy,
                        policyConfig: {
                          ...editingPolicy.policyConfig,
                          pattern: e.target.value,
                        },
                      })
                    }
                    placeholder="e.g. \\b\\d{17}[\\dXx]\\b"
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditingPolicy(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
