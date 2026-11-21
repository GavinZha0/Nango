/**
 * Helpers for extracting editable fields from both flat `propose_page_edit`
 * payloads and layered `getCurrentData()` snapshots (used by `discardDraft`).
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Extracts target page fields (`description`, `content`) from either a flat
 * KB draft payload or a layered `{ collection, pages, selectedPage }` snapshot.
 */
export function extractTargetKbPage(
  draft: Record<string, unknown>,
): Record<string, unknown> {
  return asRecord(draft.selectedPage) ?? draft;
}

export interface ExtractedSkillDraft {
  source?: unknown;
  skillMd?: unknown;
  fileContent?: unknown;
  selectedPath?: string;
}

/**
 * Extracts editable skill fields (`source`, `skillMd`, `fileContent`) from
 * either a flat skill draft payload or a layered `{ skill, files, selectedFile }` snapshot.
 */
export function extractTargetSkillDraft(
  draft: Record<string, unknown>,
  primaryPath = "SKILL.md",
): ExtractedSkillDraft {
  const skillObj = asRecord(draft.skill);
  const selectedFileObj = asRecord(draft.selectedFile);

  if (!skillObj && !selectedFileObj) {
    return {
      source: draft.source,
      skillMd: draft.skillMd,
      fileContent: draft.fileContent,
    };
  }

  const selectedPath =
    typeof selectedFileObj?.path === "string" ? selectedFileObj.path : undefined;
  const isPrimary = selectedPath === primaryPath;

  return {
    source: skillObj?.source ?? draft.source,
    skillMd: isPrimary
      ? (selectedFileObj?.content ?? skillObj?.skillMd ?? draft.skillMd)
      : (skillObj?.skillMd ?? draft.skillMd),
    fileContent: !isPrimary
      ? (selectedFileObj?.content ?? draft.fileContent)
      : draft.fileContent,
    selectedPath,
  };
}
