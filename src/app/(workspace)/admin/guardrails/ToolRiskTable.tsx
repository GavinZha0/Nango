"use client";

/**
 * ToolRiskTable — Clean Header + Table component for Built-in & MCP tool risk overrides.
 *
 * Placed in the upper half of the right column (60% width) in Guardrail Console.
 * Allows row-level overrides of RiskLevel, RequireApproval, HeadlessAllowed, and Enabled status.
 */

import { useState } from "react";
import { Wrench, Check, X, Plus, SquarePen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";

export interface ToolRiskItem {
  id?: number;
  toolName: string;
  source: "builtin" | "mcp";
  mcpServerId?: string | null;
  riskLevel: "low" | "medium" | "high" | "critical";
  requireApproval: "inherit" | "always" | "never";
  headlessAllowed: boolean;
  enabled: boolean;
  isNew?: boolean;
}

interface ToolRiskTableProps {
  items: ToolRiskItem[];
  onSaveOverride?: (item: ToolRiskItem) => Promise<void>;
  onDeleteOverride?: (item: ToolRiskItem) => Promise<void>;
}

export function ToolRiskTable({ items, onSaveOverride, onDeleteOverride }: ToolRiskTableProps) {
  const [editingItem, setEditingItem] = useState<ToolRiskItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingItem, setDeletingItem] = useState<ToolRiskItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleCreateNew = () => {
    setEditingItem({
      toolName: "",
      source: "builtin",
      mcpServerId: null,
      riskLevel: "medium",
      requireApproval: "inherit",
      headlessAllowed: true,
      enabled: true,
      isNew: true,
    });
  };

  const handleSave = async () => {
    if (!editingItem || !editingItem.toolName.trim() || !onSaveOverride) return;
    setSaving(true);
    try {
      await onSaveOverride(editingItem);
      setEditingItem(null);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (item: ToolRiskItem, checked: boolean) => {
    if (!onSaveOverride) return;
    await onSaveOverride({ ...item, enabled: checked });
  };

  const handleDeleteClick = (item: ToolRiskItem) => {
    setDeletingItem(item);
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingItem || !onDeleteOverride) return;
    setDeleting(true);
    try {
      await onDeleteOverride(deletingItem);
      setDeleteConfirmOpen(false);
      setDeletingItem(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header Bar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b bg-muted/20 px-3 py-1 mb-1.5 rounded-t-md">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-primary" />
          <span className="text-xs font-semibold text-foreground">Tool Risk Registry</span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
            {items.filter((i) => i.enabled).length}/{items.length}
          </Badge>
        </div>

        <Button
          size="sm"
          variant="outline"
          className="h-6.5 text-[11px] gap-1 px-2"
          onClick={handleCreateNew}
        >
          <Plus className="h-3 w-3" />
          Add tool
        </Button>
      </div>

      {/* Table Container */}
      <div className="flex-1 overflow-auto rounded-md border bg-background/50">
        <Table>
          <TableHeader className="bg-muted/40 sticky top-0">
            <TableRow className="h-7 border-b">
              <TableHead className="text-[11px] font-semibold py-1">Tool Name</TableHead>
              <TableHead className="text-[11px] font-semibold py-1">Source</TableHead>
              <TableHead className="text-[11px] font-semibold py-1">Risk Level</TableHead>
              <TableHead className="text-[11px] font-semibold py-1">Approval</TableHead>
              <TableHead className="text-[11px] font-semibold py-1">Headless</TableHead>
              <TableHead className="text-[11px] font-semibold py-1">Status</TableHead>
              <TableHead className="text-[11px] font-semibold text-right py-1">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-6">
                  No tool risk rules configured
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={`${item.source}:${item.mcpServerId ?? ""}:${item.toolName}`} className="h-8 hover:bg-muted/30">
                  <TableCell className="font-mono text-xs font-medium py-0.5">
                    {item.toolName}
                  </TableCell>
                  <TableCell className="py-0.5 text-xs text-muted-foreground capitalize">
                    {item.source}
                  </TableCell>
                  <TableCell className="py-0.5 text-xs text-muted-foreground capitalize">
                    {item.riskLevel}
                  </TableCell>
                  <TableCell className="py-0.5 text-xs text-muted-foreground capitalize">
                    {item.requireApproval}
                  </TableCell>
                  <TableCell className="py-0.5">
                    {item.headlessAllowed ? (
                      <Check className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <X className="h-3 w-3 text-muted-foreground/40" />
                    )}
                  </TableCell>
                  <TableCell className="py-0.5">
                    <Switch
                      checked={item.enabled}
                      onCheckedChange={(checked) => handleToggleEnabled(item, checked)}
                      className="scale-75"
                    />
                  </TableCell>
                  <TableCell className="text-right py-0.5">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5"
                        onClick={() => setEditingItem({ ...item })}
                      >
                        <SquarePen className="h-3 w-3" />
                      </Button>
                      {onDeleteOverride && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-destructive"
                          onClick={() => handleDeleteClick(item)}
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
        title="Delete tool risk rule"
        description={
          <span>
            Are you sure you want to delete the risk rule for{" "}
            <strong className="font-mono">{deletingItem?.toolName}</strong>? This action cannot be undone.
          </span>
        }
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        onConfirm={handleDeleteConfirm}
        deleting={deleting}
      />

      {/* Edit / Create Modal */}
      <Dialog open={!!editingItem} onOpenChange={(open) => !open && setEditingItem(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              {editingItem?.isNew ? (
                "Add Tool Risk Rule"
              ) : (
                <>
                  Edit Tool Risk Rule: <span className="font-mono text-primary">{editingItem?.toolName}</span>
                </>
              )}
            </DialogTitle>
          </DialogHeader>

          {editingItem && (
            <div className="space-y-3.5 py-1 text-xs">
              {editingItem.isNew && (
                <>
                  <div className="space-y-1">
                    <Label>Tool Name</Label>
                    <Input
                      value={editingItem.toolName}
                      onChange={(e) => setEditingItem({ ...editingItem, toolName: e.target.value })}
                      placeholder="e.g. run_python_script"
                      className="h-8 text-xs font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label>Source</Label>
                    <Select
                      value={editingItem.source}
                      items={[
                        { value: "builtin", label: "Builtin (Native system tools)" },
                        { value: "mcp", label: "MCP (Model Context Protocol)" },
                      ]}
                      onValueChange={(val: string | null) =>
                        val && setEditingItem({
                          ...editingItem,
                          source: val as ToolRiskItem["source"],
                        })
                      }
                    >
                      <SelectTrigger className="w-full h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="builtin">Builtin (Native system tools)</SelectItem>
                        <SelectItem value="mcp">MCP (Model Context Protocol)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              <div className="space-y-1">
                <Label>Risk Level</Label>
                <Select
                  value={editingItem.riskLevel}
                  items={[
                    { value: "low", label: "low (Low risk - Auto allow)" },
                    { value: "medium", label: "medium (Medium risk - Write ops)" },
                    { value: "high", label: "high (Needs approval)" },
                    { value: "critical", label: "critical (Destructive ops)" },
                  ]}
                  onValueChange={(val: string | null) =>
                    val && setEditingItem({
                      ...editingItem,
                      riskLevel: val as ToolRiskItem["riskLevel"],
                    })
                  }
                >
                  <SelectTrigger className="w-full h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">low (Low risk - Auto allow)</SelectItem>
                    <SelectItem value="medium">medium (Medium risk - Write ops)</SelectItem>
                    <SelectItem value="high">high (Needs approval)</SelectItem>
                    <SelectItem value="critical">critical (Destructive ops)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>Require Approval</Label>
                <Select
                  value={editingItem.requireApproval}
                  items={[
                    { value: "inherit", label: "inherit (Inherit global risk evaluation)" },
                    { value: "always", label: "always (Unconditionally require approval)" },
                    { value: "never", label: "never (Bypass approval completely)" },
                  ]}
                  onValueChange={(val: string | null) =>
                    val && setEditingItem({
                      ...editingItem,
                      requireApproval: val as ToolRiskItem["requireApproval"],
                    })
                  }
                >
                  <SelectTrigger className="w-full h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">inherit (Inherit global risk evaluation)</SelectItem>
                    <SelectItem value="always">always (Unconditionally require approval)</SelectItem>
                    <SelectItem value="never">never (Bypass approval completely)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between border-t pt-3">
                <Label htmlFor="headless-switch">Allow Headless / Scheduled Tasks</Label>
                <Switch
                  id="headless-switch"
                  checked={editingItem.headlessAllowed}
                  onCheckedChange={(checked) =>
                    setEditingItem({ ...editingItem, headlessAllowed: checked })
                  }
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditingItem(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving || (editingItem?.isNew && !editingItem.toolName.trim())}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
