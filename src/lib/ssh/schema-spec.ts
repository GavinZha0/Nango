/**
 * SSH Server — Active resource schema contract specification.
 *
 * Symmetrically describes the activeResourceData structure and the
 * propose_page_edit draftData contract for the SSH Server module.
 */

export const SSH_SERVER_ACTIVE_RESOURCE_SCHEMA = {
  version: "1.0",
  resourceType: "ssh-server",
  description:
    "SSH Server Editor symmetric state contract. When calling propose_page_edit, draftData MUST mirror this structure.",
  properties: {
    name: {
      type: "string",
      editable: true,
      maxLength: 63,
      description:
        "Unique SSH host identifier matching /^[a-z][a-z0-9_-]{0,62}$/ (e.g. 'prod_web_01', 'bastion_host')",
    },
    description: {
      type: "string",
      editable: true,
      description:
        "Description injected into agent system prompt explaining server purpose, OS environment, and allowed operations",
    },
    credentialId: {
      type: "string",
      editable: true,
      description:
        "UUID of the bound SSH credential containing username and password or private key",
    },
    host: {
      type: "string",
      editable: true,
      description: "SSH server hostname or IP address",
    },
    port: {
      type: "integer",
      editable: true,
      minimum: 1,
      maximum: 65535,
      description: "SSH connection port (default: 22)",
    },
    knownHostFingerprint: {
      type: "string",
      editable: true,
      description:
        "Pinned host-key fingerprint matching /^SHA256:[A-Za-z0-9+/=]+$/ for MITM security verification",
    },
    commandAllow: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of allowed command regex patterns (null or empty array allows all commands)",
    },
    commandApprove: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of command regex patterns requiring interactive user approval before execution",
    },
    commandDeny: {
      type: "array",
      items: { type: "string" },
      editable: true,
      description:
        "List of forbidden command regex patterns (takes precedence over allowlist)",
    },
    loginShell: {
      type: "boolean",
      editable: true,
      description:
        "When true, wraps commands as 'bash -lc' to source login environment profile scripts (default: true)",
    },
  },
  required: ["name", "credentialId", "host", "port", "knownHostFingerprint"],
} as const;
