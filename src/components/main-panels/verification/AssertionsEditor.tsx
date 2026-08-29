"use client";

/**
 * AssertionsEditor — Verification module wrapper around UniversalAssertionsEditor.
 *
 * Mode: "verification"
 * Provides 100% unified 3-field JSONPath, JS Expression, Schema, and JSON tabs.
 *
 * See docs/verification.md.
 */

import type { ReactNode } from "react";
import { UniversalAssertionsEditor } from "@/components/main-panels/common/UniversalAssertionsEditor";

export interface AssertionsEditorProps {
  draft: {
    text: string;
    setText: (next: string) => void;
    parseError: string | null;
    saving: boolean;
    isDirty: boolean;
  };
  readOnly: boolean;
  overrideText?: string | null;
}

export function AssertionsEditor({
  draft,
  readOnly,
  overrideText = null,
}: AssertionsEditorProps): ReactNode {
  return (
    <UniversalAssertionsEditor
      mode="verification"
      draft={draft}
      readOnly={readOnly}
      overrideText={overrideText}
    />
  );
}
