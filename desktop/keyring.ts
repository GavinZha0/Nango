/**
 * OS-backed master secret generation and persistence for Nango Desktop.
 *
 * Uses Electron's `safeStorage` (Windows DPAPI / macOS Keychain / Linux libsecret)
 * when available to encrypt `CREDENTIAL_ENCRYPTION_KEYRING`, `BETTER_AUTH_SECRET`,
 * and `POSTGRES_PASSWORD` at `<userData>/secrets.bin`.
 *
 * See docs/desktop-architecture.md.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface DesktopSecrets {
  /** Versioned AES-256-GCM keyring (`"v1:<64-hex-chars>"`). */
  credentialEncryptionKeyring: string;
  /** 32-byte hex secret for better-auth session signing. */
  betterAuthSecret: string;
  /** Random password for the local PostgreSQL `nango` superuser. */
  postgresPassword: string;
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredEnvelope {
  version: 1;
  encrypted: boolean;
  payloadBase64: string;
}

const SECRETS_FILENAME = "secrets.bin";

/**
 * Generate a fresh set of cryptographically random desktop secrets.
 */
export function generateDesktopSecrets(): DesktopSecrets {
  const aesKeyHex = crypto.randomBytes(32).toString("hex");
  const authSecretHex = crypto.randomBytes(32).toString("hex");
  const pgPasswordHex = crypto.randomBytes(24).toString("hex");

  return {
    credentialEncryptionKeyring: `v1:${aesKeyHex}`,
    betterAuthSecret: authSecretHex,
    postgresPassword: pgPasswordHex,
  };
}

/**
 * Validate that a parsed JSON object satisfies the `DesktopSecrets` contract.
 */
export function isValidDesktopSecrets(candidate: unknown): candidate is DesktopSecrets {
  if (!candidate || typeof candidate !== "object") return false;
  const rec = candidate as Record<string, unknown>;
  return (
    typeof rec.credentialEncryptionKeyring === "string" &&
    /^v1:[0-9a-fA-F]{64}$/.test(rec.credentialEncryptionKeyring) &&
    typeof rec.betterAuthSecret === "string" &&
    rec.betterAuthSecret.length >= 32 &&
    typeof rec.postgresPassword === "string" &&
    rec.postgresPassword.length >= 16
  );
}

export interface KeyringOptions {
  /**
   * When true, allow falling back to mode-0600 unencrypted storage if OS
   * `safeStorage` is unavailable (e.g. headless Linux without libsecret).
   * Defaults to `process.env.NANGO_ALLOW_PLAINTEXT_KEYRING === "true"`.
   */
  allowPlaintextFallback?: boolean;
}

/**
 * Load existing desktop secrets from `<userDataDir>/secrets.bin`, or generate
 * and persist new secrets atomically on first boot.
 *
 * SECURITY: Requires OS `safeStorage` encryption by default; plaintext fallback
 * is refused unless explicitly opted in via `allowPlaintextFallback` or
 * `NANGO_ALLOW_PLAINTEXT_KEYRING=true`, and logs a prominent warning when used.
 */
export function loadOrCreateDesktopSecrets(
  userDataDir: string,
  safeStorage?: SafeStorageAdapter,
  opts?: KeyringOptions,
): DesktopSecrets {
  fs.mkdirSync(userDataDir, { recursive: true });
  const secretsPath = path.join(userDataDir, SECRETS_FILENAME);
  const canEncrypt = Boolean(safeStorage?.isEncryptionAvailable());
  const allowPlaintext =
    opts?.allowPlaintextFallback ??
    process.env.NANGO_ALLOW_PLAINTEXT_KEYRING === "true";

  if (fs.existsSync(secretsPath)) {
    const rawText = fs.readFileSync(secretsPath, "utf8");
    const envelope = JSON.parse(rawText) as StoredEnvelope;
    const rawBuffer = Buffer.from(envelope.payloadBase64, "base64");

    let jsonString: string;
    if (envelope.encrypted) {
      if (!safeStorage || !canEncrypt) {
        throw new Error(
          "Desktop secrets file is encrypted with OS safeStorage, but safeStorage decryption is currently unavailable.",
        );
      }
      jsonString = safeStorage.decryptString(rawBuffer);
    } else {
      if (!allowPlaintext) {
        throw new Error(
          "Desktop secrets file is unencrypted and plaintext keyring fallback is disabled (set NANGO_ALLOW_PLAINTEXT_KEYRING=true to allow).",
        );
      }
      console.warn(
        "[desktop/keyring] WARNING: Loading unencrypted secrets.bin fallback (OS safeStorage not used).",
      );
      jsonString = rawBuffer.toString("utf8");
    }

    const parsed: unknown = JSON.parse(jsonString);
    if (!isValidDesktopSecrets(parsed)) {
      throw new Error("Stored desktop secrets failed integrity validation.");
    }
    return parsed;
  }

  if (!canEncrypt && !allowPlaintext) {
    throw new Error(
      "OS safeStorage encryption (DPAPI/Keychain/libsecret) is unavailable. Refusing to persist plaintext desktop secrets (set NANGO_ALLOW_PLAINTEXT_KEYRING=true to override).",
    );
  }

  if (!canEncrypt) {
    console.warn(
      "[desktop/keyring] WARNING: OS safeStorage encryption is unavailable; persisting secrets.bin with mode-0600 plaintext fallback.",
    );
  }

  const secrets = generateDesktopSecrets();
  const serialized = JSON.stringify(secrets);
  const payloadBuffer =
    canEncrypt && safeStorage
      ? safeStorage.encryptString(serialized)
      : Buffer.from(serialized, "utf8");

  const envelope: StoredEnvelope = {
    version: 1,
    encrypted: canEncrypt,
    payloadBase64: payloadBuffer.toString("base64"),
  };

  const tmpPath = `${secretsPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, secretsPath);

  return secrets;
}
