/**
 * extractTargetCase — Universally extracts the target case data object from Copilot draft payloads.
 *
 * Supported draft shapes:
 * 1. draft.selectedCase
 * 2. draft.case
 * 3. draft.cases array (searches by currentCaseId or takes first)
 * 4. draft.suites[].cases array
 * 5. draft.suite.cases array
 * 6. Direct flat draft object
 */
export function extractTargetCase(
  draft: Record<string, unknown>,
  currentCaseId?: number | string | null,
): Record<string, unknown> {
  // 1. Direct selectedCase
  if (draft.selectedCase && typeof draft.selectedCase === "object" && !Array.isArray(draft.selectedCase)) {
    return draft.selectedCase as Record<string, unknown>;
  }

  // 2. Direct case
  if (draft.case && typeof draft.case === "object" && !Array.isArray(draft.case)) {
    return draft.case as Record<string, unknown>;
  }

  const searchInCases = (casesList: unknown[]): Record<string, unknown> | null => {
    if (!Array.isArray(casesList) || casesList.length === 0) return null;
    if (currentCaseId != null) {
      const match = casesList.find((c) => (c as Record<string, unknown>)?.id == currentCaseId);
      if (match && typeof match === "object") return match as Record<string, unknown>;
    }
    const first = casesList[0];
    if (first && typeof first === "object") return first as Record<string, unknown>;
    return null;
  };

  // 3. draft.cases array
  if (Array.isArray(draft.cases)) {
    const found = searchInCases(draft.cases);
    if (found) return found;
  }

  // 4. draft.suites array (e.g. draft.suites[0].cases)
  if (Array.isArray(draft.suites)) {
    for (const s of draft.suites) {
      if (s && typeof s === "object" && Array.isArray((s as Record<string, unknown>).cases)) {
        const found = searchInCases((s as Record<string, unknown>).cases as unknown[]);
        if (found) return found;
      }
    }
  }

  // 5. draft.suite object (e.g. draft.suite.cases)
  if (draft.suite && typeof draft.suite === "object" && !Array.isArray(draft.suite)) {
    const s = draft.suite as Record<string, unknown>;
    if (Array.isArray(s.cases)) {
      const found = searchInCases(s.cases);
      if (found) return found;
    }
  }

  // 6. Direct flat draft
  return draft;
}
