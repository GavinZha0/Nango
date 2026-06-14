import { useEffect, useRef, useState } from "react";
import { useCopilotSharedState } from "@/hooks/useCopilotSharedState";

export interface UseCopilotDraftOptions<T extends Record<string, unknown>> {
  /** The resource key in the drafts object, e.g., 'schedule', 'agent', 'skill' */
  resourceType: string;
  /** Function to get the current state of the form to sync to the agent */
  getCurrentData: () => T;
  /** Callback fired when a draft is received. Should update component state. */
  applyDraft: (draft: Partial<T>) => void;
}

export function useCopilotDraft<T extends Record<string, unknown>>({
  resourceType,
  getCurrentData,
  applyDraft,
}: UseCopilotDraftOptions<T>) {
  const { drafts, clearDraft, setActiveResourceData } = useCopilotSharedState();
  const draft = drafts[resourceType] as Partial<T> | undefined;

  const [draftApplied, setDraftApplied] = useState(false);
  const preDraftRef = useRef<T | null>(null);

  // Keep latest callbacks in refs to avoid useEffect dependency churn
  const callbacksRef = useRef({ getCurrentData, applyDraft });
  useEffect(() => {
    callbacksRef.current = { getCurrentData, applyDraft };
  });

  // 1. Sync current state to global context continuously.
  // Stringify to avoid infinite renders if getCurrentData returns a new object reference every time.
  const dataJson = JSON.stringify(getCurrentData());
  
  useEffect(() => {
    setActiveResourceData(JSON.parse(dataJson));
    return () => setActiveResourceData(null);
  }, [dataJson, setActiveResourceData]);

  // 2. Watch for drafts and apply them
  useEffect(() => {
    if (draft && Object.keys(draft).length > 0) {
      const timer = setTimeout(() => {
        // Snapshot the state before applying if we haven't already
        if (!preDraftRef.current) {
          preDraftRef.current = callbacksRef.current.getCurrentData();
        }
        
        callbacksRef.current.applyDraft(draft);
        setDraftApplied(true);
        clearDraft(resourceType);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [draft, clearDraft, resourceType]);

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
