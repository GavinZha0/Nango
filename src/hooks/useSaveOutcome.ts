"use client";

/**
 * useSaveOutcome — promote a transient Outcome into the permanent
 * Artifact library via POST /api/artifacts/save.
 *
 * See docs/data-visualization.md and docs/workflow-architecture.md.
 *
 * Wire shape:
 *   request:  { threadId, outcomeId, parentId?, name?, description? }
 *   response: { artifactId, workflowId, workflowOutputField, reused }
 *
 * The server resolves `(threadId, outcomeId)` to the underlying
 * `(runId, toolCallId)` by scanning the thread's `tool_call_chunk`
 * events (see `resolveOutcomeToCall` in `save-artifact.ts`) — the
 * client only knows the producer-chosen outcome id (chart_id for
 * generate_echarts_config, toolCallId for web_search) and need not
 * care about OpenAI tool call ids or run ids.
 *
 * Contract:
 *  - Returns `{ save, isSaving }`. `save(outcome)` is idempotent at
 *    the UI layer: if `outcome.savedArtifactId` is already set we
 *    short-circuit without firing a request. The server is ALSO
 *    idempotent on `(sourceThreadId, sourceOutcomeId)` so concurrent
 *    double-fires return the existing artifact (`reused: true`).
 *  - On success, `outcomeStore.markSaved` records the new artifact
 *    id and a toast confirms.
 *  - On failure, the outcome stays un-saved (no markSaved call) and
 *    a destructive toast tells the user.
 *
 * The block array stored in `Outcome.blocks` is no longer pushed to
 * the server — the new save endpoint re-derives the renderable
 * config from the originating tool call's args (via
 * `build-from-events.ts` → `strippedFrontendConfig`). The Outcome's
 * blocks remain useful for the live in-chat preview; once saved,
 * the artifact's content is the workflow-shaped reconstruction.
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";

import { useOutcomeStore, type Outcome } from "@/store/outcome-store";
import { useWorkspaceStore } from "@/store/workspace";

export interface SaveOutcomeOverrides {
  /** Override the artifact name (defaults to `outcome.title`). */
  name?: string;
  /** Override the destination folder (defaults to the seed category
   *  matching `outcome.kind`). When omitted, the server picks for us. */
  parentId?: string;
  /** Override the description (defaults to `outcome.description`). */
  description?: string | null;
}

interface UseSaveOutcomeReturn {
  /** Save with optional overrides from the dialog. Returns `true` on
   *  success so callers (the dialog) can close themselves. */
  save: (
    outcome: Outcome,
    overrides?: SaveOutcomeOverrides,
  ) => Promise<boolean>;
  isSaving: boolean;
}

interface SaveArtifactResponse {
  artifactId: string;
  workflowId: string;
  workflowOutputField: string;
  reused: boolean;
}

interface SaveArtifactBody {
  threadId: string;
  outcomeId: string;
  parentId?: string;
  name?: string;
  description?: string | null;
}

export function useSaveOutcome(): UseSaveOutcomeReturn {
  const markSaved = useOutcomeStore((s) => s.markSaved);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const save = useCallback(
    async (
      outcome: Outcome,
      overrides: SaveOutcomeOverrides = {},
    ): Promise<boolean> => {
      // UI-layer guard: don't fire a request for an already-saved
      // outcome. The card UI hides the Save icon in this case, but
      // belt-and-braces here for any future programmatic caller.
      if (outcome.savedArtifactId !== null) return true;

      setIsSaving(true);
      try {
        // Fall back to live runtimeThreadId in case the outcome was
        // created during the run before lazy-capture (its `threadId`
        // field would still be null in that window).
        // See docs/chat-flow-audit.md.
        const liveThreadId: string | null =
          useWorkspaceStore.getState().runtimeThreadId;
        const threadId: string | null = outcome.threadId ?? liveThreadId;
        if (!threadId) {
          toast.error("Cannot save — thread not yet established");
          return false;
        }
        const body: SaveArtifactBody = {
          threadId,
          outcomeId: outcome.outcomeId,
          ...(overrides.parentId !== undefined && { parentId: overrides.parentId }),
          ...(overrides.name !== undefined && { name: overrides.name }),
          ...(overrides.description !== undefined && {
            description: overrides.description,
          }),
        };
        const res = await fetch("/api/artifacts/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          // Try to surface the server's structured error envelope
          // (`{ ok:false, message: "..." }` from `route-handlers.ts`)
          // so the toast tells the user *why* it failed. Fall back
          // to status text for non-JSON bodies.
          let detail: string = `${res.status} ${res.statusText}`;
          try {
            const errBody: { message?: string } = await res.json();
            if (errBody?.message) detail = errBody.message;
          } catch {
            /* non-JSON body — keep status text fallback */
          }
          throw new Error(detail);
        }

        const data: SaveArtifactResponse = await res.json();
        markSaved(outcome.outcomeId, data.artifactId);
        toast.success(
          data.reused
            ? "Already in Artifact library"
            : "Saved to Artifact library",
        );
        return true;
      } catch (err) {
        console.error("[useSaveOutcome] save failed:", err);
        const detail: string =
          err instanceof Error && err.message ? err.message : "please try again";
        toast.error(`Failed to save — ${detail}`);
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [markSaved],
  );

  return { save, isSaving };
}


