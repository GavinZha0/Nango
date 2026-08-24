/**
 * Skills — Active resource schema contract specification.
 *
 * Symmetrically describes the activeResourceData structure and the
 * propose_page_edit draftData contract for the Skills module.
 */

export const SKILL_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "skill",
  description:
    "Skill Editor symmetric state contract. Builtin skills are immutable (read-only); custom skills allow editing skillMd. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    name: {
      type: "string",
      editable: true,
      description:
        "Skill unique slug identifier (e.g. 'csv-analyst', 'pdf-extractor'). Editable on creation, immutable once created.",
    },
    source: {
      type: "string",
      enum: ["builtin", "local"],
      readOnly: true,
      description:
        "Origin of the skill: 'builtin' (system-seeded, immutable) vs 'local' (custom user-created).",
    },
    isReadOnly: {
      type: "boolean",
      readOnly: true,
      description:
        "Indicates whether this skill is locked against edits (true for builtin skills).",
    },
    skillMd: {
      type: "string",
      editable: true,
      description:
        "Complete SKILL.md text containing YAML frontmatter (name, description, version) and Markdown procedure instructions.",
    },
  },
  required: ["name", "skillMd"],
} as const;
