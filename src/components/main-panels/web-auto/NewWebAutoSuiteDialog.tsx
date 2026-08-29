"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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

export interface NewWebAutoSuiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: WebAutoTarget[];
  defaultTargetId?: string | null;
  defaultMcpServerId?: string | null;
  onCreated?: (created: WebAutoSuiteRow) => void;
}

export function NewWebAutoSuiteDialog({
  open,
  onOpenChange,
  targets,
  defaultTargetId = null,
  defaultMcpServerId = null,
  onCreated,
}: NewWebAutoSuiteDialogProps): ReactNode {
  const [selectedTargetId, setSelectedTargetId] = useState<string>("");
  const [newTargetName, setNewTargetName] = useState<string>("");
  const [suiteName, setSuiteName] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const [lastOpen, setLastOpen] = useState<boolean>(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setSuiteName("");
      setDescription("");
      setNewTargetName("");
      if (defaultTargetId) {
        setSelectedTargetId(defaultTargetId);
      } else if (targets.length > 0) {
        setSelectedTargetId(targets[0].id);
      } else {
        setSelectedTargetId("NEW_TARGET");
      }
    }
  }

  const isCreatingNewTarget = selectedTargetId === "NEW_TARGET" || targets.length === 0;

  const handleSubmit = async () => {
    if (isCreatingNewTarget && !newTargetName.trim()) {
      toast.error("Target name is required");
      return;
    }
    if (!suiteName.trim()) {
      toast.error("Suite name is required");
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
          name: suiteName.trim(),
          description: description.trim() || null,
          parentId: targetId,
          mcpServerId: defaultMcpServerId,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Web Automation Suite</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* 1. Target Selector */}
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

          {/* 2. Suite Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="suite-name">
              Suite Name <span className="text-destructive">*</span>
            </Label>
            <Input
              required
              id="suite-name"
              value={suiteName}
              onChange={(e) => setSuiteName(e.target.value)}
              disabled={isSubmitting}
              autoFocus={!isCreatingNewTarget}
            />
          </div>

          {/* 3. Description */}
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
              !suiteName.trim() ||
              (isCreatingNewTarget && !newTargetName.trim())
            }
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : (
              "Create Suite"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
