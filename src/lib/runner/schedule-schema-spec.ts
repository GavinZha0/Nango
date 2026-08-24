/**
 * Schedule — Active resource schema contract specification.
 *
 * Symmetrically describes the activeResourceData structure and the
 * propose_page_edit draftData contract for the Schedule module.
 */

export const SCHEDULE_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "schedule",
  description:
    "Schedule Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    name: {
      type: "string",
      editable: true,
      maxLength: 120,
      description: "Optional human-readable schedule title (e.g. 'Daily Market Digest')",
    },
    task: {
      type: "string",
      editable: true,
      description: "The prompt instruction dispatched to the target agent on each scheduled tick",
    },
    agentKey: {
      type: "string",
      editable: true,
      description: "Target agent identifier in 'builtin:<agentId>' or '<credentialId>:<entityId>' format",
    },
    triggerMode: {
      type: "string",
      enum: ["one_shot", "recurring"],
      editable: true,
      description: "Trigger strategy: 'one_shot' for one-time execution, 'recurring' for periodic repeats",
    },
    intervalValue: {
      type: "string",
      editable: true,
      description: "Repeat interval integer value (e.g. '1', '2', '12'). Required when triggerMode is 'recurring'",
    },
    intervalUnit: {
      type: "string",
      enum: ["minute", "hour", "day", "week", "month"],
      editable: true,
      description: "Repeat interval calendar unit. Required when triggerMode is 'recurring'",
    },
    startLocal: {
      type: "string",
      editable: true,
      description: "First run datetime in local 'YYYY-MM-DDTHH:mm' format (e.g. '2026-08-25T09:00') or ISO 8601 UTC string",
    },
    endLocal: {
      type: "string",
      editable: true,
      description: "Optional end datetime window in local 'YYYY-MM-DDTHH:mm' format (or empty string/null if open-ended)",
    },
    timezone: {
      type: "string",
      editable: true,
      description: "IANA timezone string (e.g. 'Asia/Shanghai', 'America/New_York', 'UTC')",
    },
  },
  required: ["task", "triggerMode", "startLocal"],
} as const;
