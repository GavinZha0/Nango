/**
 * Server-only SshServer lookup — name / id → fully-hydrated row + decrypted auth.
 *
 * See docs/ssh.md.
 */

import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { SshServerTable, type SshServerEntity } from "@/lib/db/schema";

import { loadSshAuth } from "./auth-loader";
import type { NormalisedSshAuth } from "./credential-schema";

/**
 * The shape passed into the SSH client. Connection metadata from
 * `ssh_server` + the decrypted+normalised auth blob from the
 * credential. `username` is sourced from the credential payload —
 * the `ssh_server` row no longer carries it.
 */
export interface ResolvedSshServer {
  id: string;
  name: string;
  description: string | null;
  host: string;
  port: number;
  /** From the bound credential (basic_auth.username / private_key.username). */
  username: string;
  knownHostFingerprint: string;
  /** Allowlist of regex patterns; null = no constraint (see
   *  `lib/ssh/policy.ts` for evaluation rules). */
  commandAllow: string[] | null;
  /** Denylist of regex patterns; takes precedence over allow on a
   *  match. */
  commandDeny: string[];
  /** Wrap commands as `bash -lc '…'` on this host. */
  loginShell: boolean;
  auth: NormalisedSshAuth;
}

export type SshLookupError =
  | "NOT_FOUND"
  | "DISABLED"
  | "CREDENTIAL_MISSING"
  | "CREDENTIAL_DECRYPT_FAILED";

export interface SshLookupOk {
  ok: true;
  resolved: ResolvedSshServer;
}
export interface SshLookupFail {
  ok: false;
  error: SshLookupError;
  message: string;
}
export type SshLookupResult = SshLookupOk | SshLookupFail;

/**
 * Resolve an ssh_server row by its LLM-facing name and load the
 * referenced credential's auth blob. Honours the `enabled` flag —
 * disabled rows return DISABLED so the caller can surface a
 * targeted error rather than a generic "not found" leak.
 */
export async function resolveSshServerByName(
  name: string,
): Promise<SshLookupResult> {
  const rows = await db
    .select()
    .from(SshServerTable)
    .where(eq(SshServerTable.name, name))
    .limit(1);

  if (rows.length === 0) {
    return {
      ok: false,
      error: "NOT_FOUND",
      message: `No SSH server named '${name}' is configured.`,
    };
  }
  const row = rows[0];
  return resolveFromRow(row);
}

/** Resolve by row id (test-connection endpoint, admin paths with UUID). */
export async function resolveSshServerById(
  id: string,
): Promise<SshLookupResult> {
  const rows = await db
    .select()
    .from(SshServerTable)
    .where(eq(SshServerTable.id, id))
    .limit(1);

  if (rows.length === 0) {
    return {
      ok: false,
      error: "NOT_FOUND",
      message: `SSH server id ${id} not found.`,
    };
  }
  return resolveFromRow(rows[0]);
}

async function resolveFromRow(
  row: SshServerEntity,
): Promise<SshLookupResult> {
  if (!row.enabled) {
    return {
      ok: false,
      error: "DISABLED",
      message: `SSH server '${row.name}' is disabled.`,
    };
  }

  const auth = await loadSshAuth(row.credentialId);
  if (!auth) {
    return {
      ok: false,
      error: "CREDENTIAL_DECRYPT_FAILED",
      message:
        `SSH server '${row.name}' references credential ${row.credentialId} ` +
        "which is missing, disabled, or fails to decrypt.",
    };
  }

  return {
    ok: true,
    resolved: {
      id: row.id,
      name: row.name,
      description: row.description,
      host: row.host,
      port: row.port,
      username: auth.username,
      knownHostFingerprint: row.knownHostFingerprint,
      commandAllow: row.commandAllow,
      commandDeny: row.commandDeny,
      loginShell: row.loginShell,
      auth,
    },
  };
}

/**
 * Compact projection used by the prompt block + `list_ssh_hosts`
 * tool. Only enabled rows; auth NOT loaded — `username` lives on
 * the credential and isn't surfaced to the LLM at listing time.
 *
 * `commandAllow` / `commandDeny` are exposed so the prompt block
 * can hint at restrictions ("(restricted)") and so `list_ssh_hosts`
 * can show the LLM the surface it has to work with — a denied
 * command then surfaces with `error: "POLICY_DENIED"` at runtime.
 */
export interface SshServerListing {
  id: string;
  name: string;
  description: string | null;
  host: string;
  port: number;
  commandAllow: string[] | null;
  commandDeny: string[];
}

/** List ssh_server rows by id (e.g. agent-bound rows) — enabled only. */
export async function listSshServersByIds(
  ids: string[],
): Promise<SshServerListing[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: SshServerTable.id,
      name: SshServerTable.name,
      description: SshServerTable.description,
      host: SshServerTable.host,
      port: SshServerTable.port,
      commandAllow: SshServerTable.commandAllow,
      commandDeny: SshServerTable.commandDeny,
      enabled: SshServerTable.enabled,
    })
    .from(SshServerTable)
    .where(
      and(
        inArray(SshServerTable.id, ids),
        eq(SshServerTable.enabled, true),
      ),
    )
    .orderBy(SshServerTable.name);
  return rows.map(({ enabled, ...rest }) => {
    void enabled;
    return rest;
  });
}
