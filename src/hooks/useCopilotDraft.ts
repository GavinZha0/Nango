import { useEffect, useId, useRef, useState } from "react";
import { useCopilotStateStore } from "@/store/copilot";

export interface UseCopilotDraftOptions<T extends Record<string, unknown>> {
  /** The resource key in the drafts object, e.g., 'schedule', 'agent', 'skill' */
  resourceType: string;
  /** Optional resource ID for instance identification */
  resourceId?: string | null;
  /** Whether the resource is read-only */
  isReadOnly?: boolean;
  /** Function to get the current state of the form to sync to the agent */
  getCurrentData: () => T;
  /** Callback fired when a draft is received. Should update component state. */
  applyDraft: (draft: Partial<T>) => void;
}

export function useCopilotDraft<T extends Record<string, unknown>>({
  resourceType,
  resourceId = null,
  isReadOnly = false,
  getCurrentData,
  applyDraft,
}: UseCopilotDraftOptions<T>) {
  const instanceId = useId();
  const registerEditor = useCopilotStateStore((s) => s.registerEditor);
  const unregisterEditor = useCopilotStateStore((s) => s.unregisterEditor);
  const setActiveResourceData = useCopilotStateStore((s) => s.setActiveResourceData);

  const [draftApplied, setDraftApplied] = useState(false);
  const preDraftRef = useRef<T | null>(null);

  // Keep latest callbacks in refs to avoid useEffect dependency churn
  const callbacksRef = useRef({ getCurrentData, applyDraft, isReadOnly, resourceId });
  useEffect(() => {
    callbacksRef.current = { getCurrentData, applyDraft, isReadOnly, resourceId };
  });

  // 1. Register editor slot with the store for direct tool dispatch
  useEffect(() => {
    registerEditor({
      instanceId,
      resourceType,
      resourceId,
      isReadOnly,
      getCurrentData: () => callbacksRef.current.getCurrentData(),
      applyDraft: (draftData) => {
        if (callbacksRef.current.isReadOnly) return [];
        if (!preDraftRef.current) {
          preDraftRef.current = callbacksRef.current.getCurrentData();
        }
        callbacksRef.current.applyDraft(draftData as Partial<T>);
        setDraftApplied(true);
        return Object.keys(draftData);
      },
      discardDraft: () => {
        if (preDraftRef.current) {
          callbacksRef.current.applyDraft(preDraftRef.current);
          preDraftRef.current = null;
          setDraftApplied(false);
        }
      },
    });

    return () => unregisterEditor(instanceId);
  }, [instanceId, resourceType, resourceId, isReadOnly, registerEditor, unregisterEditor]);

  // 2. Sync current state to global context with 150ms debounce to avoid render churn
  const dataJson = JSON.stringify(getCurrentData());

  useEffect(() => {
    const timer = setTimeout(() => {
      setActiveResourceData(JSON.parse(dataJson));
    }, 150);
    return () => clearTimeout(timer);
  }, [dataJson, setActiveResourceData]);

  // Clean up activeResourceData on unmount if this instance owns the active editor
  useEffect(() => {
    return () => {
      if (useCopilotStateStore.getState().activeEditor?.instanceId === instanceId) {
        setActiveResourceData(null);
      }
    };
  }, [instanceId, setActiveResourceData]);

  // 3. Discard draft logic
  const discardDraft = () => {
    if (preDraftRef.current) {
      callbacksRef.current.applyDraft(preDraftRef.current);
      preDraftRef.current = null;
      setDraftApplied(false);
    }
  };

  // 4. Manual clear (e.g., when the user successfully saves the form to the backend)
  const clearDraftState = () => {
    setDraftApplied(false);
    preDraftRef.current = null;
  };

  return {
    draftApplied,
    discardDraft,
    clearDraftState,
  };
}
