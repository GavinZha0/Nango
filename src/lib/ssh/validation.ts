/**
 * Shared input schemas for the ssh-server REST API.
 */

import "server-only";

import { z } from "zod";

/** Globally-unique LLM-facing slug. Same regex as data_source.name. */
export const SSH_SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export const sshServerName = z
  .string()
  .min(1, "name is required")
  .regex(
    SSH_SERVER_NAME_RE,
    "name must start with a-z and contain only [a-z0-9_-] (max 63 chars)",
  );

/** SHA256:<base64> per RFC 4255 / `ssh-keygen -lf` output. */
export const sshFingerprint = z
  .string()
  .regex(
    /^SHA256:[A-Za-z0-9+/=]+$/,
    "fingerprint must be SHA256:<base64> — produce on a trusted machine with `ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -`",
  );

const commandList = z.array(z.string().min(1));

/** Shared body for POST. */
export const createSshServerSchema = z.object({
  name: sshServerName,
  description: z.string().trim().max(1024).nullish(),

  credentialId: z.string().uuid("credentialId must be a UUID"),
  host: z.string().trim().min(1, "host is required"),
  port: z.number().int().min(1).max(65535).optional(),
  /** Optional. API runs implicit `verifyConnection` when omitted; auth must succeed or row is rejected. */
  knownHostFingerprint: sshFingerprint.optional(),

  // Enforced at runtime by `lib/ssh/policy.ts`. `commandAllow ===
  // null` is "no constraint"; an empty array is "deny all".
  commandAllow: commandList.nullable().optional(),
  commandDeny: commandList.optional(),

  /** Wrap commands in `bash -lc '...'`. Defaults to true server-side. @see docs/ssh.md §3.3 */
  loginShell: z.boolean().optional(),

  enabled: z.boolean().optional(),
  visibility: z.enum(["private", "public"]).optional(),
});

/** PATCH allows any subset. `name` is FIXED — rename requires delete + recreate (same as data_source.name). */
export const updateSshServerSchema = z
  .object({
    description: z.string().trim().max(1024).nullable().optional(),

    credentialId: z.string().uuid("credentialId must be a UUID").optional(),
    host: z.string().trim().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    knownHostFingerprint: sshFingerprint.optional(),

    commandAllow: commandList.nullable().optional(),
    commandDeny: commandList.optional(),

    loginShell: z.boolean().optional(),

    enabled: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export type CreateSshServerInput = z.infer<typeof createSshServerSchema>;
export type UpdateSshServerInput = z.infer<typeof updateSshServerSchema>;
