import { useEffect, useId, useRef, useState, useCallback } from "react";
import { useCopilotStateStore } from "@/store/copilot";

export interface UseCopilotDraftOptions<T extends Record<string, unknown>> {
  /** The resource key matching canonical ResourceType, e.g., 'schedule', 'agent', 'skills' */
  resourceType: string;
  /** Optional resource ID for instance identification */
  resourceId?: string | null;
  /** Whether the resource is read-only */
  isReadOnly?: boolean;
  /** Function to get the current state of the form to sync to the agent */
  getCurrentData: () => T;
  /** Callback fired when a draft is received. Can optionally return array of actually modified field names. */
  applyDraft: (draft: Partial<T>) => string[] | void;
}

function sanitizeData<T extends Record<string, unknown>>(raw: T): T {
  if (!raw || typeof raw !== "object") return raw;
  const sanitized = { ...raw };
  delete (sanitized as Record<string, unknown>).apiKey;
  delete (sanitized as Record<string, unknown>).password;
  delete (sanitized as Record<string, unknown>).token;
  delete (sanitized as Record<string, unknown>).privateKey;
  return sanitized;
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
  const prevSerializedRef = useRef<string>("");

  // Keep latest callbacks in refs to avoid useEffect dependency churn
  const callbacksRef = useRef({ getCurrentData, applyDraft, isReadOnly, resourceId });
  useEffect(() => {
    callbacksRef.current = { getCurrentData, applyDraft, isReadOnly, resourceId };
  });

  const discardDraft = useCallback(() => {
    if (preDraftRef.current) {
      callbacksRef.current.applyDraft(preDraftRef.current);
      preDraftRef.current = null;
      setDraftApplied(false);
    }
  }, []);

  const clearDraftState = useCallback(() => {
    setDraftApplied(false);
    preDraftRef.current = null;
  }, []);

  // 1. Register editor slot with the store for direct tool dispatch
  useEffect(() => {
    registerEditor({
      instanceId,
      resourceType,
      resourceId,
      isReadOnly,
      getCurrentData: () => sanitizeData(callbacksRef.current.getCurrentData()),
      applyDraft: (draftData) => {
        if (callbacksRef.current.isReadOnly) return [];
        if (!preDraftRef.current) {
          preDraftRef.current = callbacksRef.current.getCurrentData();
        }
        const customResult = callbacksRef.current.applyDraft(draftData as Partial<T>);

        let actualApplied: string[] = [];
        if (Array.isArray(customResult)) {
          actualApplied = customResult;
        } else {
          // Fallback: compare updated state against snapshot to determine genuinely modified keys
          const afterData = callbacksRef.current.getCurrentData();
          const beforeData = preDraftRef.current || {};
          actualApplied = Object.keys(draftData).filter((key) => {
            const beforeVal = (beforeData as Record<string, unknown>)[key];
            const afterVal = (afterData as Record<string, unknown>)[key];
            return JSON.stringify(beforeVal) !== JSON.stringify(afterVal);
          });
          // If no diff was detected (e.g. state hasn't flushed synchronously), fallback to keys in draftData
          if (actualApplied.length === 0 && Object.keys(draftData).length > 0) {
            actualApplied = Object.keys(draftData);
          }
        }

        if (actualApplied.length > 0) {
          setDraftApplied(true);
        }
        return actualApplied;
      },
      discardDraft,
    });

    return () => unregisterEditor(instanceId);
  }, [instanceId, resourceType, resourceId, isReadOnly, registerEditor, unregisterEditor, discardDraft]);

  // 2. Sync current state to global context with 150ms debounce (serialized strictly inside timer)
  useEffect(() => {
    const timer = setTimeout(() => {
      const current = callbacksRef.current.getCurrentData();
      const serialized = JSON.stringify(current);
      if (serialized !== prevSerializedRef.current) {
        prevSerializedRef.current = serialized;
        setActiveResourceData(sanitizeData(current));
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [getCurrentData, setActiveResourceData]);

  // Clean up activeResourceData on unmount if this instance owns the active editor
  useEffect(() => {
    return () => {
      if (useCopilotStateStore.getState().activeEditor?.instanceId === instanceId) {
        setActiveResourceData(null);
      }
    };
  }, [instanceId, setActiveResourceData]);

  return {
    draftApplied,
    discardDraft,
    clearDraftState,
  };
}
