import { useCopilotStateStore } from "@/store/copilot";
import { RESOURCE_TYPES, DRAFT_SCHEMAS } from "./resource-registry";

/**
 * Core handler logic for propose_page_edit tool execution.
 * Pure logic decoupled for direct unit & integration verification.
 */
export async function executeProposePageEdit({
  resourceType,
  draftData,
}: {
  resourceType: (typeof RESOURCE_TYPES)[number];
  draftData: Record<string, unknown>;
}) {
  const editor = useCopilotStateStore.getState().activeEditor;
  if (!editor) {
    return {
      isError: true,
      message: "No active resource editor is currently open. Ask the user to navigate to the resource editor first.",
    };
  }

  // Guard: reject empty drafts (#6)
  if (!draftData || Object.keys(draftData).length === 0) {
    return {
      isError: true,
      message: "Draft data cannot be empty. Please specify the fields you want to change.",
    };
  }

  // Guard: reject resourceType mismatch (Safety Interlock against cross-page contamination)
  if (editor.resourceType !== resourceType) {
    return {
      isError: true,
      message: `Mismatch: current editor is viewing '${editor.resourceType}', but draft targets '${resourceType}'. Navigate first or use backend tools.`,
    };
  }

  // Guard: reject read-only/builtin resources (#1)
  if (editor.isReadOnly) {
    return {
      isError: true,
      message: `Permission Denied: This ${editor.resourceType} is read-only (builtin) and cannot be edited.`,
    };
  }

  // Guard: enforce Zod Schema validation for known resource types
  const draftSchema = DRAFT_SCHEMAS[resourceType];
  if (draftSchema) {
    const parseResult = draftSchema.safeParse(draftData);
    if (!parseResult.success) {
      const formattedErrors = parseResult.error.issues
        .map((issue) => `${issue.path.join(".") || "draftData"}: ${issue.message}`)
        .join("; ");
      return {
        isError: true,
        message: `Invalid draft payload for ${resourceType}: ${formattedErrors}`,
      };
    }
  }

  // Apply directly to the active editor
  const appliedFields = editor.applyDraft(draftData);
  if (!appliedFields || appliedFields.length === 0) {
    return {
      isError: true,
      message: "None of the provided fields were accepted or modified by the editor.",
    };
  }

  return {
    status: "success",
    resourceType: editor.resourceType,
    appliedFields,
    message: `Draft applied, please save.`,
  };
}

/**
 * Core handler logic for discard_page_edit tool execution.
 */
export async function executeDiscardPageEdit({
  resourceType,
}: {
  resourceType: (typeof RESOURCE_TYPES)[number];
}) {
  const editor = useCopilotStateStore.getState().activeEditor;
  if (!editor) {
    return {
      isError: true,
      message: `No active draft found for ${resourceType}.`,
    };
  }
  if (editor.resourceType !== resourceType) {
    return {
      isError: true,
      message: `No active draft found for ${resourceType}. Current editor is viewing '${editor.resourceType}'.`,
    };
  }
  editor.discardDraft();
  return {
    status: "success",
    resourceType: editor.resourceType,
    message: `Draft changes for ${editor.resourceType} have been discarded and original values restored.`,
  };
}
