/**
 * Decrypt + parse the auth blob from a credential row that an
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { CredentialTable } from "@/lib/db/schema";
import { decrypt } from "@/lib/credentials/crypto";
import { childLogger } from "@/lib/observability/logger";

import {
  SshBasicAuthPayload,
  SshPrivateKeyPayload,
  type NormalisedSshAuth,
} from "./credential-schema";

const log = childLogger({ component: "ssh-auth-loader" });

/**
 * SECURITY: strict guard. Returns null unless the row is enabled,
 * its `type` is one of {`basic_auth`, `private_key`}, decrypts
 * cleanly, and parses against the matching payload schema. The
 * `provider` column is intentionally NOT filtered — an admin may
 * reuse a credential row across SSH and other integrations.
 *
 * Decryption / parse failures log a warn and return null — a
 * malformed credential should not crash the agent run; the tool
 * wrapper surfaces a "credential not loadable" error instead.
 */
export async function loadSshAuth(
  credentialId: string,
): Promise<NormalisedSshAuth | null> {
  const rows = await db
    .select({
      id: CredentialTable.id,
      type: CredentialTable.type,
      encryptedPayload: CredentialTable.encryptedPayload,
    })
    .from(CredentialTable)
    .where(
      and(
        eq(CredentialTable.id, credentialId),
        eq(CredentialTable.enabled, true),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];

  if (row.type !== "basic_auth" && row.type !== "private_key") {
    log.warn(
      { credentialId, type: row.type },
      "ssh credential has unsupported type (expected basic_auth or private_key)",
    );
    return null;
  }

  let raw: Record<string, unknown>;
  try {
    raw = decrypt(row.encryptedPayload);
  } catch (err) {
    log.warn(
      { credentialId, err: err instanceof Error ? err.message : String(err) },
      "ssh credential decrypt failed",
    );
    return null;
  }

  if (row.type === "basic_auth") {
    const parsed = SshBasicAuthPayload.safeParse(raw);
    if (!parsed.success) {
      log.warn(
        { credentialId, issues: parsed.error.issues },
        "basic_auth payload failed schema validation",
      );
      return null;
    }
    return {
      kind: "password",
      username: parsed.data.username,
      password: parsed.data.password,
    };
  }

  const parsed = SshPrivateKeyPayload.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      { credentialId, issues: parsed.error.issues },
      "private_key payload failed schema validation",
    );
    return null;
  }
  return {
    kind: "privateKey",
    username: parsed.data.username,
    privateKey: parsed.data.privateKey,
    passphrase: parsed.data.passphrase,
  };
}
