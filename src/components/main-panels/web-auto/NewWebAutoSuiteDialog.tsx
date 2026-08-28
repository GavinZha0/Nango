"use client";

import { useState, useMemo, useEffect, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import useSWR, { mutate } from "swr";
import { useWorkspaceStore } from "@/store/workspace";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWebAutoTree, type WebAutoSuiteRow } from "@/store/web-auto-store";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json();
};

export interface NewWebAutoSuiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (createdId: string) => void;
  suiteToEdit?: WebAutoSuiteRow | null;
}

export interface McpServerOption {
  id: string;
  name: string;
  enabled?: boolean;
}

export function NewWebAutoSuiteDialog({
  open,
  onOpenChange,
  onCreated,
  suiteToEdit,
}: NewWebAutoSuiteDialogProps): ReactNode {
  const tree = useWebAutoTree();
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const evaluators = useMemo(() => builtinAgents.filter((a) => a.role === "evaluator"), [builtinAgents]);

  const { data: mcpServers } = useSWR<McpServerOption[]>("/api/mcp-servers", fetcher);

  // Identify preferred default Playwright MCP server
  const defaultPlaywrightServer = useMemo(() => {
    if (!mcpServers || mcpServers.length === 0) return null;
    const exactMatch = mcpServers.find(
      (s) =>
        s.name.toLowerCase() === "playwright" ||
        s.name.toLowerCase() === "playwright-mcp",
    );
    if (exactMatch) return exactMatch;
    return mcpServers.find((s) => s.name.toLowerCase().includes("playwright")) ?? null;
  }, [mcpServers]);
  
  const [form, setForm] = useState({
    name: "",
    groupId: "",
    newGroupName: "",
    evaluatorAgentId: "",
    mcpServerId: "",
    description: "",
  });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Initialize form state when opening / closing
  useEffect(() => {
    if (open) {
      if (suiteToEdit) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({
          name: suiteToEdit.name,
          description: suiteToEdit.description || "",
          groupId: suiteToEdit.parentId || suiteToEdit.id,
          newGroupName: "",
          evaluatorAgentId: suiteToEdit.evaluatorAgentId || "",
          mcpServerId: suiteToEdit.mcpServerId || defaultPlaywrightServer?.id || "",
        });
      } else {
        setForm({
          name: "",
          groupId: "",
          newGroupName: "",
          evaluatorAgentId: "",
          mcpServerId: defaultPlaywrightServer?.id || "",
          description: "",
        });
      }
      setSubmitError(null);
    }
  }, [open, suiteToEdit, defaultPlaywrightServer]);

  const isNewGroup = form.groupId === "NEW_GROUP";
  const hasValidGroup = isNewGroup
    ? form.newGroupName.trim().length > 0
    : form.groupId !== "";

  const trimmedName = form.name.trim();
  const isEditingGroup = suiteToEdit && suiteToEdit.parentId === null;
  const canSubmit =
    !submitting &&
    trimmedName.length > 0 &&
    (isEditingGroup || hasValidGroup);

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (suiteToEdit) {
        // Edit mode
        if (isEditingGroup) {
          // Edit group
          const res = await fetch(`/api/web-auto-suites/${suiteToEdit.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: trimmedName,
              description: form.description.trim() || null,
            }),
          });
          if (!res.ok) throw new Error("Failed to update group");
        } else {
          // Edit suite
          const res = await fetch(`/api/web-auto-suites/${suiteToEdit.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: trimmedName,
              description: form.description.trim() || null,
              parentId: form.groupId,
              evaluatorAgentId: form.evaluatorAgentId || null,
              mcpServerId: form.mcpServerId || null,
            }),
          });
          if (!res.ok) throw new Error("Failed to update suite");
        }
        await mutate("/api/web-auto-suites");
        toast.success("Updated successfully");
        onOpenChange(false);
        return;
      }

      let finalGroupId = form.groupId;

      // 1. Create a new group if requested
      if (isNewGroup) {
        const res = await fetch("/api/web-auto-suites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.newGroupName.trim(),
            visibility: "public",
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.message || "Failed to create group");
        }
        const createdGroup = await res.json();
        finalGroupId = createdGroup.id;
      }

      // 2. Create the actual suite
      const resSuite = await fetch("/api/web-auto-suites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          description: form.description.trim() || null,
          parentId: finalGroupId,
          visibility: "public",
          evaluatorAgentId: form.evaluatorAgentId || null,
          mcpServerId: form.mcpServerId || null,
        }),
      });
      if (!resSuite.ok) {
        const err = await resSuite.json().catch(() => null);
        throw new Error(err?.message || "Failed to create suite");
      }
      const createdSuite = await resSuite.json();

      await mutate("/api/web-auto-suites");
      toast.success("Created web auto suite", {
        description: `Suite "${createdSuite.name}"`,
      });

      onCreated(createdSuite.id);
      onOpenChange(false);
      setForm({
        name: "",
        groupId: "",
        newGroupName: "",
        evaluatorAgentId: "",
        mcpServerId: "",
        description: "",
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !submitting) {
          onOpenChange(false);
          setForm({
            name: "",
            groupId: "",
            newGroupName: "",
            evaluatorAgentId: "",
            mcpServerId: "",
            description: "",
          });
          setSubmitError(null);
        } else if (isOpen) {
          onOpenChange(true);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{suiteToEdit ? (isEditingGroup ? "Edit Group" : "Edit Suite") : "New Suite"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {!isEditingGroup && (
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <Label htmlFor="groupId" className="text-sm font-semibold">
                Group <span className="text-destructive">*</span>
              </Label>
              <Select
                value={form.groupId}
                onValueChange={(val) => setForm((prev) => ({ ...prev, groupId: val || "", newGroupName: "" }))}
                disabled={submitting}
              >
                <SelectTrigger id="groupId" className="w-full">
                  <SelectValue placeholder="Select a group...">
                    {form.groupId === "NEW_GROUP" ? (
                      <span className="text-primary font-semibold">+ Create New Group...</span>
                    ) : (
                      tree.find((g) => g.id === form.groupId)?.name || null
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {tree.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                  {!suiteToEdit && (
                    <SelectItem
                      value="NEW_GROUP"
                      className="font-medium text-primary focus:text-primary focus:bg-primary/10"
                    >
                      + Create New Group...
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {isNewGroup && !isEditingGroup && (
            <div className="grid grid-cols-[120px_1fr] items-center gap-2">
              <Label htmlFor="newGroupName" className="text-sm font-semibold text-muted-foreground">
                Group Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="newGroupName"
                value={form.newGroupName}
                onChange={(e) => setForm((prev) => ({ ...prev, newGroupName: e.target.value }))}
                placeholder="e.g. Authentication"
                autoFocus
                disabled={submitting}
              />
            </div>
          )}

          <div className="grid grid-cols-[120px_1fr] items-center gap-2">
            <Label htmlFor="suiteName" className="text-sm font-semibold">
              Suite Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="suiteName"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. Login Flow Tests"
              autoFocus={!isNewGroup}
              disabled={submitting}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
            />
          </div>

          <div className="grid grid-cols-[120px_1fr] items-start gap-2">
            <Label htmlFor="description" className="text-sm font-semibold pt-2">
              Description
            </Label>
            <Textarea
              id="description"
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="Optional natural language description..."
              disabled={submitting}
              rows={2}
              className="resize-none"
            />
          </div>

          {!isEditingGroup && (
            <>
              <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                <Label htmlFor="mcpServerId" className="text-sm font-semibold">
                  Playwright MCP <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={form.mcpServerId}
                  onValueChange={(val) =>
                    setForm((prev) => ({ ...prev, mcpServerId: val || "" }))
                  }
                  disabled={submitting}
                >
                  <SelectTrigger id="mcpServerId" className="w-full">
                    <SelectValue placeholder="Configure Playwright MCP first">
                      {form.mcpServerId
                        ? mcpServers?.find((m) => m.id === form.mcpServerId)?.name || "Selected Server"
                        : null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {mcpServers?.map((server) => (
                      <SelectItem key={server.id} value={server.id}>
                        {server.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                <Label htmlFor="evaluatorAgentId" className="text-sm font-semibold">
                  Evaluator
                </Label>
                <Select
                  value={form.evaluatorAgentId}
                  onValueChange={(val) =>
                    setForm((prev) => ({ ...prev, evaluatorAgentId: val === "NONE" ? "" : (val || "") }))
                  }
                  disabled={submitting}
                >
                  <SelectTrigger id="evaluatorAgentId" className="w-full">
                    <SelectValue placeholder="Optional evaluator agent...">
                      {form.evaluatorAgentId ? (
                        evaluators.find((e) => e.id === form.evaluatorAgentId)?.name || "Unknown Agent"
                      ) : (
                        <span className="text-muted-foreground">None (No AI Evaluation)</span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE" className="text-muted-foreground italic">
                      None (No AI Evaluation)
                    </SelectItem>
                    {evaluators.map((ev) => (
                      <SelectItem key={ev.id} value={ev.id}>
                        {ev.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {submitError && (
            <div className="text-sm text-destructive font-medium">{submitError}</div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {suiteToEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
