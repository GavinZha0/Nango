"use client";

import { useState, type ReactNode, useEffect } from "react";
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

interface VerificationSuiteEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  suite?: { id: string; name: string } | null;
  onSave: (name: string) => Promise<void>;
}

export function VerificationSuiteEditDialog({
  open,
  onOpenChange,
  serverName,
  suite,
  onSave,
}: VerificationSuiteEditDialogProps): ReactNode {
  const [name, setName] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(suite?.name ?? "");
      setError(null);
    }
  }, [open, suite]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSave(trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{suite ? "Edit Suite" : "New Suite"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <p className="rounded border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                {error}
              </p>
            )}

            <div className="grid grid-cols-[100px_1fr] items-center gap-4">
              <Label htmlFor="suite-server">MCP Server</Label>
              <Input
                id="suite-server"
                value={serverName}
                disabled
                className="bg-muted cursor-not-allowed opacity-80"
              />
            </div>

            <div className="grid grid-cols-[100px_1fr] items-center gap-4">
              <Label htmlFor="suite-name">Suite Name</Label>
              <Input
                id="suite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter suite name"
                required
                maxLength={120}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}