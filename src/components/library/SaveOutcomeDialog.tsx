"use client";

/**
 * SaveOutcomeDialog — confirmation dialog before promoting an Outcome
 * into the Artifact library. Replaces the prior silent-save flow.
 *
 * Defaults are taken from the outcome itself:
 *  - `name`        ← `outcome.title`
 *  - `description` ← `outcome.description`
 *  - `folder`      ← the seed category whose name matches `outcome.kind`
 *                    (e.g. `chart → Charts`). Falls back to the first
 *                    root if the lookup misses (defensive — the kind
 *                    set is hard-coded).
 *
 * On confirm: calls `useSaveOutcome.save(outcome, { name, parentId,
 * description })`. The hook still owns the API call, idempotency,
 * and the success / failure toast. The dialog only closes when the
 * hook resolves with `true` so the user sees the spinner inside the
 * dialog body, not behind it.
 *
 * @see docs/artifact-dashboard-migration.md §11.2
 */

import { Loader2, Save } from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type ReactElement,
} from "react";

import { ArtifactFolderTreeSelect } from "@/components/library/ArtifactFolderTreeSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useArtifactTree } from "@/hooks/useArtifactTree";
import { useSaveOutcome } from "@/hooks/useSaveOutcome";
import { lookupCategoryForType, type ArtifactType } from "@/lib/domain/artifact";
import type { Outcome } from "@/store/outcome-store";

export interface SaveOutcomeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outcome: Outcome;
}

export function SaveOutcomeDialog({
  open,
  onOpenChange,
  outcome,
}: SaveOutcomeDialogProps): ReactElement {
  const { tree, mutate } = useArtifactTree();
  const { save, isSaving } = useSaveOutcome();

  const [name, setName] = useState<string>(outcome.title);
  const [description, setDescription] = useState<string>(
    outcome.description ?? "",
  );
  // `null` means "no user override yet" — render falls back to
  // `defaultFolderId` derived below. User selection in the picker
  // sets this to a real id, taking precedence.
  const [folderId, setFolderId] = useState<string | null>(null);

  // Derive the default category from the outcome's block
  // composition — a pure single-chart Report lands in "Charts"
  // (the artifact type the server records); anything else
  // (card_list, text, or mixed blocks) lands in "Reports". Mirrors
  // the `artifactType` decision in `useSaveOutcome.toCreateArtifactBody`
  // so the picker default and the saved row's folder agree.
  const defaultCategoryName: string | undefined = useMemo(() => {
    const isSingleChart: boolean =
      outcome.blocks.length === 1 && outcome.blocks[0].kind === "chart";
    const artifactType: ArtifactType = isSingleChart ? "chart" : "report";
    return lookupCategoryForType(artifactType)?.name;
  }, [outcome.blocks]);

  // Derived during render: the root folder whose name matches the
  // outcome's category, with the first-root fallback so submission
  // is never blocked. No effect needed — recomputes whenever the
  // tree or category changes, and `null` is harmless when the tree
  // is still loading.
  const defaultFolderId: string | null = useMemo(() => {
    if (!tree) return null;
    const match = tree.find(
      (r) => r.parentId === null && r.name === defaultCategoryName,
    );
    return match?.id ?? tree[0]?.id ?? null;
  }, [tree, defaultCategoryName]);

  // Reset the form whenever the dialog transitions to open. Uses the
  // React-blessed "previous-value during render" pattern instead of
  // useEffect+setState because effect-driven resets cause cascading
  // renders and trip react-hooks/set-state-in-effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [prevOpen, setPrevOpen] = useState<boolean>(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setName(outcome.title);
      setDescription(outcome.description ?? "");
      setFolderId(null);
    }
  }

  const resolvedFolderId: string | null = folderId ?? defaultFolderId;
  const trimmedName: string = name.trim();
  const canSubmit: boolean =
    !isSaving && trimmedName.length > 0 && resolvedFolderId !== null;

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!canSubmit || resolvedFolderId === null) return;
    const ok: boolean = await save(outcome, {
      name: trimmedName,
      parentId: resolvedFolderId,
      description: description.trim() ? description.trim() : null,
    });
    if (ok) {
      // Re-fetch the tree so the new leaf appears in the library panel
      // without a manual refresh.
      await mutate();
      onOpenChange(false);
    }
  }, [
    canSubmit,
    resolvedFolderId,
    save,
    outcome,
    trimmedName,
    description,
    mutate,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save to Artifact library</DialogTitle>
          <DialogDescription>
            Pick a destination folder and confirm the name. The chart
            stays in this chat as well.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="artifact-name">Name</Label>
            <Input
              id="artifact-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              autoFocus
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Folder</Label>
            <ArtifactFolderTreeSelect
              value={resolvedFolderId}
              onChange={setFolderId}
              allowRoot
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="artifact-description">
              Description <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="artifact-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Add a note for future-you…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSaving ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="mr-1 h-4 w-4" />
                Save
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
