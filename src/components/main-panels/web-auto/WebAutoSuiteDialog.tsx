"use client";

import { useState, useMemo, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WebAutoSuiteRow, WebAutoTarget } from "@/store/web-auto-store";
import { useWorkspaceStore } from "@/store/workspace";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface WebAutoSuiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suite?: WebAutoSuiteRow | null;
  targets?: WebAutoTarget[];
  defaultTargetId?: string | null;
  defaultMcpServerId?: string | null;
  onCreated?: (created: WebAutoSuiteRow) => void;
  onSaved?: () => void;
}

export function WebAutoSuiteDialog({
  open,
  onOpenChange,
  suite,
  targets = [],
  defaultTargetId = null,
  defaultMcpServerId = null,
  onCreated,
  onSaved,
}: WebAutoSuiteDialogProps): ReactNode {
  const isEdit = !!suite;
  const isTarget = isEdit && suite?.parentId === null;

  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const evaluators = useMemo(
    () => builtinAgents.filter((a) => a.role === "evaluator"),
    [builtinAgents],
  );

  const { data: mcpServers = [] } = useSWR<
    Array<{ id: string; name: string; enabled?: boolean }>
  >("/api/mcp-servers", fetcher);

  const autoMatchedPlaywrightServer = useMemo(() => {
    if (!mcpServers || mcpServers.length === 0) return null;
    const exactMatch = mcpServers.find(
      (s) =>
        s.name.toLowerCase() === "playwright" ||
        s.name.toLowerCase() === "playwright-mcp",
    );
    if (exactMatch) return exactMatch;
    return (
      mcpServers.find((s) => s.name.toLowerCase().includes("playwright")) ??
      null
    );
  }, [mcpServers]);

  const [name, setName] = useState<string>(suite?.name ?? "");
  const [description, setDescription] = useState<string>(suite?.description ?? "");
  const [selectedTargetId, setSelectedTargetId] = useState<string>("");
  const [newTargetName, setNewTargetName] = useState<string>("");
  const [selectedEvalId, setSelectedEvalId] = useState<string>(
    suite?.evaluatorAgentId ?? "",
  );
  const [userSelectedMcpId, setUserSelectedMcpId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const effectiveMcpId =
    userSelectedMcpId !== null
      ? userSelectedMcpId
      : (suite?.mcpServerId ?? defaultMcpServerId ?? autoMatchedPlaywrightServer?.id ?? "");

  const [lastOpen, setLastOpen] = useState<boolean>(open);
  const [lastSuiteId, setLastSuiteId] = useState<string | null>(suite?.id ?? null);

  if (open !== lastOpen || (suite?.id ?? null) !== lastSuiteId) {
    setLastOpen(open);
    setLastSuiteId(suite?.id ?? null);
    if (open) {
      setName(suite?.name ?? "");
      setDescription(suite?.description ?? "");
      setNewTargetName("");
      setSelectedEvalId(suite?.evaluatorAgentId ?? "");
      setUserSelectedMcpId(suite?.mcpServerId ?? null);
      if (defaultTargetId) {
        setSelectedTargetId(defaultTargetId);
      } else if (targets.length > 0) {
        setSelectedTargetId(targets[0].id);
      } else {
        setSelectedTargetId("NEW_TARGET");
      }
    }
  }

  const isCreatingNewTarget = !isEdit && (selectedTargetId === "NEW_TARGET" || targets.length === 0);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error(isTarget ? "Target name is required" : "Suite name is required");
      return;
    }

    if (isEdit && suite) {
      setIsSubmitting(true);
      try {
        const res = await fetch(`/api/web-auto-suites/${suite.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || null,
            evaluatorAgentId: !isTarget && selectedEvalId ? selectedEvalId : null,
            mcpServerId: !isTarget && effectiveMcpId ? effectiveMcpId : null,
          }),
        });
        if (!res.ok) throw new Error("Failed to update");
        toast.success("Updated successfully");
        onOpenChange(false);
        onSaved?.();
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (isCreatingNewTarget && !newTargetName.trim()) {
      toast.error("Target name is required");
      return;
    }

    setIsSubmitting(true);
    try {
      let targetId = selectedTargetId;
      if (isCreatingNewTarget) {
        const targetRes = await fetch("/api/web-auto-suites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newTargetName.trim(),
            parentId: null,
          }),
        });
        if (!targetRes.ok) throw new Error("Failed to create target");
        const createdTarget = (await targetRes.json()) as WebAutoSuiteRow;
        targetId = createdTarget.id;
      }

      const suiteRes = await fetch("/api/web-auto-suites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          parentId: targetId,
          mcpServerId: effectiveMcpId ? effectiveMcpId : null,
          evaluatorAgentId: selectedEvalId ? selectedEvalId : null,
        }),
      });
      if (!suiteRes.ok) throw new Error("Failed to create automation suite");
      const createdSuite = (await suiteRes.json()) as WebAutoSuiteRow;
      toast.success("Automation suite created");
      onOpenChange(false);
      onCreated?.(createdSuite);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const title = isEdit ? (isTarget ? "Edit Target" : "Edit Suite") : "New Suite";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Target Selector (Only in New Mode) */}
          {!isEdit && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="target-select">
                Target <span className="text-destructive">*</span>
              </Label>
              <Select
                required
                value={selectedTargetId}
                onValueChange={(val) => setSelectedTargetId(val ?? "")}
                disabled={isSubmitting}
              >
                <SelectTrigger id="target-select" className="w-full">
                  <SelectValue placeholder="Select target">
                    {selectedTargetId === "NEW_TARGET" ? (
                      <span className="text-primary font-semibold">
                        + Create new target...
                      </span>
                    ) : selectedTargetId ? (
                      targets.find((t) => t.id === selectedTargetId)?.name ||
                      "Select target"
                    ) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.id} value={t.id} label={t.name}>
                      {t.name}
                    </SelectItem>
                  ))}
                  <SelectItem
                    value="NEW_TARGET"
                    label="+ Create new target..."
                    className="text-primary font-semibold"
                  >
                    + Create new target...
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* New Target Name Input if creating new */}
          {isCreatingNewTarget && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-target-name">
                Target Name <span className="text-destructive">*</span>
              </Label>
              <Input
                required
                id="new-target-name"
                value={newTargetName}
                onChange={(e) => setNewTargetName(e.target.value)}
                disabled={isSubmitting}
                autoFocus
              />
            </div>
          )}

          {/* Suite / Target Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="suite-name">
              {isTarget ? "Target Name" : "Suite Name"}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              required
              id="suite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
              autoFocus={!isCreatingNewTarget}
            />
          </div>

          {/* Evaluator (Only for Suites, not Target groups) */}
          {!isTarget && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-agent">Evaluator</Label>
              <Select
                value={selectedEvalId || "__none__"}
                onValueChange={(val) => setSelectedEvalId(val === "__none__" ? "" : (val ?? ""))}
                disabled={isSubmitting}
              >
                <SelectTrigger id="eval-agent" className="w-full">
                  <SelectValue placeholder="None">
                    {selectedEvalId === "" || selectedEvalId === "__none__"
                      ? "None"
                      : evaluators.find((a) => a.id === selectedEvalId)?.name || "None"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" label="None">
                    None
                  </SelectItem>
                  {evaluators.map((a) => (
                    <SelectItem key={a.id} value={a.id} label={a.name}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* MCP Server (Only for Suites, not Target groups) */}
          {!isTarget && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-server">MCP Server</Label>
              <Select
                value={effectiveMcpId || "__none__"}
                onValueChange={(val) => setUserSelectedMcpId(val === "__none__" ? "" : (val ?? ""))}
                disabled={isSubmitting}
              >
                <SelectTrigger id="mcp-server" className="w-full">
                  <SelectValue placeholder="None">
                    {effectiveMcpId === "" || effectiveMcpId === "__none__"
                      ? "None"
                      : mcpServers.find((s) => s.id === effectiveMcpId)?.name || "None"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" label="None">
                    None
                  </SelectItem>
                  {mcpServers.map((s) => (
                    <SelectItem key={s.id} value={s.id} label={s.name}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of this suite's test scope"
              rows={3}
              className="resize-none"
              disabled={isSubmitting}
            />
          </div>
        </div>

        <DialogFooter className="mt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              isSubmitting ||
              !name.trim() ||
              (isCreatingNewTarget && !newTargetName.trim())
            }
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
