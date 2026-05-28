/**
 * AES-256-GCM encryption / decryption for credential payloads.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm" as const;
const SCHEMA_VERSION = "v1" as const;
// SECURITY: 96-bit IV is the recommended size for GCM. Changing this
// breaks decryption of every existing v1 row — bump SCHEMA_VERSION.
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32; // 256-bit
const KEY_HEX_LEN = KEY_BYTES * 2;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const ENV_KEYRING = "CREDENTIAL_ENCRYPTION_KEYRING";
const ENV_ACTIVE_KEY_ID = "CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID";

interface Keyring {
  /** keyId -> 32-byte key buffer. */
  readonly keys: ReadonlyMap<string, Buffer>;
  /** Id of the key used for encryption of new rows. */
  readonly activeKeyId: string;
}

let cachedKeyring: Keyring | null = null;

/**
 * @see docs/key-rotation.md#6-implementation-details-and-quirks
 */
function loadKeyring(): Keyring {
  if (cachedKeyring) return cachedKeyring;

  const ringSpec: string | undefined = process.env[ENV_KEYRING];
  const activeKeyId: string | undefined = process.env[ENV_ACTIVE_KEY_ID];

  if (!ringSpec || ringSpec.trim() === "") {
    throw new Error(
      `${ENV_KEYRING} is required. Format: "k1=<64-hex>,k2=<64-hex>". ` +
        `Generate a key with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  if (!activeKeyId || activeKeyId.trim() === "") {
    throw new Error(
      `${ENV_ACTIVE_KEY_ID} is required (e.g. "k1") and must reference an entry in ${ENV_KEYRING}.`,
    );
  }

  const keys = new Map<string, Buffer>();
  for (const rawEntry of ringSpec.split(",")) {
    const entry: string = rawEntry.trim();
    if (entry === "") continue;
    const eqIdx: number = entry.indexOf("=");
    if (eqIdx < 1) {
      throw new Error(
        `${ENV_KEYRING}: invalid entry "${entry}". Expected "<keyId>=<64-hex>".`,
      );
    }
    const keyId: string = entry.slice(0, eqIdx).trim();
    const keyHex: string = entry.slice(eqIdx + 1).trim();
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new Error(
        `${ENV_KEYRING}: invalid keyId "${keyId}". Must match ${KEY_ID_PATTERN}.`,
      );
    }
    if (keyHex.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(keyHex)) {
      throw new Error(
        `${ENV_KEYRING}: key for "${keyId}" must be a ${KEY_HEX_LEN}-character hex string (${KEY_BYTES} bytes).`,
      );
    }
    if (keys.has(keyId)) {
      throw new Error(`${ENV_KEYRING}: duplicate keyId "${keyId}".`);
    }
    keys.set(keyId, Buffer.from(keyHex, "hex"));
  }

  if (keys.size === 0) {
    throw new Error(`${ENV_KEYRING} is empty after parsing.`);
  }
  if (!keys.has(activeKeyId)) {
    throw new Error(
      `${ENV_ACTIVE_KEY_ID}="${activeKeyId}" is not present in ${ENV_KEYRING}.`,
    );
  }

  cachedKeyring = { keys, activeKeyId };
  return cachedKeyring;
}

/** Test / migration helper. Production code never needs this. */
export function resetKeyringCache(): void {
  cachedKeyring = null;
}

/**
 * Encrypt a JSON-serialisable payload using the active key.
 * CONTRACT: returns a single `:`-joined string safe for a text column.
 *
 * SECURITY: a fresh 96-bit IV is drawn per call from `randomBytes`.
 * GCM is catastrophically broken if (key, IV) ever repeats — we MUST
 * NOT cache or derive the IV from the payload.
 */
export function encrypt(payload: Record<string, unknown>): string {
  const { keys, activeKeyId } = loadKeyring();
  const key: Buffer = keys.get(activeKeyId)!;

  const iv: Buffer = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext: string = JSON.stringify(payload);
  const encrypted: Buffer = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag: Buffer = cipher.getAuthTag();

  // SECURITY: ciphertext is base64 (binary-safe), but iv/authTag stay
  // hex so the wire format remains greppable / debuggable. Joining
  // with `:` is safe because base64 alphabet excludes `:`.
  return [
    SCHEMA_VERSION,
    activeKeyId,
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a ciphertext produced by {@link encrypt}.
 *
 * CONTRACT: throws on unknown schema version, unknown keyId,
 * malformed structure, or authentication failure (wrong key /
 * tampered data) — never returns a partial / undecrypted object.
 *
 * SECURITY: GCM auth tag verification happens inside `decipher.final()`;
 * any tampering of iv / authTag / ciphertext surfaces as a thrown
 * error rather than silent corruption.
 */
export function decrypt(ciphertext: string): Record<string, unknown> {
  const parts: string[] = ciphertext.split(":");
  if (parts.length !== 5) {
    throw new Error(
      `Invalid ciphertext format: expected ${SCHEMA_VERSION}:keyId:iv:authTag:ct (5 segments, got ${parts.length})`,
    );
  }
  const [version, keyId, ivHex, authTagHex, encryptedB64] = parts;
  // SECURITY: refuse anything that isn't the version this build supports.
  // A future v2 algorithm change will run side-by-side with a migration.
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported ciphertext version "${version}"; this build only supports "${SCHEMA_VERSION}".`,
    );
  }
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`Invalid keyId "${keyId}" in ciphertext header.`);
  }

  const { keys } = loadKeyring();
  const key: Buffer | undefined = keys.get(keyId);
  if (!key) {
    throw new Error(
      `Unknown encryption keyId "${keyId}". Add it to ${ENV_KEYRING} or re-encrypt the row with an active key.`,
    );
  }

  const iv: Buffer = Buffer.from(ivHex, "hex");
  const authTag: Buffer = Buffer.from(authTagHex, "hex");
  const encryptedData: Buffer = Buffer.from(encryptedB64, "base64");
  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (authTag.length !== TAG_BYTES) throw new Error("Invalid auth tag length");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted: Buffer = Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as Record<string, unknown>;
}

/**
 * Read the keyId from a v1 ciphertext header without decrypting.
 * Used by audit / rotation tooling to count rows per key.
 */
export function inspectCiphertextKeyId(ciphertext: string): string {
  const parts: string[] = ciphertext.split(":");
  if (parts.length !== 5 || parts[0] !== SCHEMA_VERSION) {
    throw new Error(`Invalid ${SCHEMA_VERSION} ciphertext header.`);
  }
  return parts[1];
}

/**
 * Non-sensitive preview of the primary secret value (e.g. "sk-ab…x8Qzt").
 *
 * Lookup order (most identifying first):
 *   token → key → password → clientSecret → secretKey → publicKey
 *
 * The secret half of a `keypair` is preferred over the public half
 * because it is what users recognise in their vault.
 */
export function extractKeyPreview(payload: Record<string, unknown>): string {
  const raw =
    payload.token ??
    payload.key ??
    payload.password ??
    payload.clientSecret ??
    payload.secretKey ??
    payload.publicKey;
  if (typeof raw !== "string") return "…????";
  if (raw.length >= 11) {
    return `${raw.slice(0, 5)}…${raw.slice(-5)}`;
  }
  if (raw.length >= 4) {
    return `…${raw.slice(-4)}`;
  }
  return "…????";
}
