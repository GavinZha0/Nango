import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";

const KEY_K1: string = randomBytes(32).toString("hex");
const KEY_K2: string = randomBytes(32).toString("hex");

process.env.CREDENTIAL_ENCRYPTION_KEYRING = `k1=${KEY_K1}`;
process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = "k1";

const {
  encrypt,
  decrypt,
  extractKeyPreview,
  inspectCiphertextKeyId,
  resetKeyringCache,
} = await import("@/lib/credentials/crypto");

/** Set keyring env, reset cache so the next call re-parses. */
function setKeyring(spec: string | undefined, activeId: string | undefined): void {
  if (spec === undefined) {
    delete process.env.CREDENTIAL_ENCRYPTION_KEYRING;
  } else {
    process.env.CREDENTIAL_ENCRYPTION_KEYRING = spec;
  }
  if (activeId === undefined) {
    delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID;
  } else {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = activeId;
  }
  resetKeyringCache();
}

describe("encrypt / decrypt round-trip", () => {
  beforeEach(() => {
    setKeyring(`k1=${KEY_K1}`, "k1");
  });

  it("encrypts and decrypts a simple payload", () => {
    const payload = { key: "sk-test-123456" };
    const ct: string = encrypt(payload);
    expect(decrypt(ct)).toEqual(payload);
  });

  it("handles complex nested payloads", () => {
    const payload = {
      token: "bearer-xyz",
      nested: { foo: "bar", num: 42 },
      arr: [1, 2, 3],
    };
    expect(decrypt(encrypt(payload))).toEqual(payload);
  });

  it("produces different ciphertext for the same payload (random IV)", () => {
    const payload = { key: "same-key" };
    const ct1: string = encrypt(payload);
    const ct2: string = encrypt(payload);
    expect(ct1).not.toBe(ct2);
    expect(decrypt(ct1)).toEqual(payload);
    expect(decrypt(ct2)).toEqual(payload);
  });

  it("ciphertext format is v1:keyId:iv:authTag:ct", () => {
    const ct: string = encrypt({ key: "test" });
    const parts: string[] = ct.split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("k1");
    expect(parts[2]).toHaveLength(24); // 12-byte IV in hex
    expect(parts[3]).toHaveLength(32); // 16-byte tag in hex
    expect(parts[4].length).toBeGreaterThan(0);
  });
});

describe("multi-key keyring", () => {
  it("decrypts rows produced by either key while active=k1", () => {
    setKeyring(`k1=${KEY_K1},k2=${KEY_K2}`, "k1");
    const ct1: string = encrypt({ token: "alpha" });
    expect(inspectCiphertextKeyId(ct1)).toBe("k1");

    setKeyring(`k1=${KEY_K1},k2=${KEY_K2}`, "k2");
    const ct2: string = encrypt({ token: "beta" });
    expect(inspectCiphertextKeyId(ct2)).toBe("k2");

    // Both keys still in keyring → both ciphertexts decrypt.
    expect(decrypt(ct1)).toEqual({ token: "alpha" });
    expect(decrypt(ct2)).toEqual({ token: "beta" });
  });

  it("throws when decrypting with a key that has been removed from the keyring", () => {
    setKeyring(`k1=${KEY_K1},k2=${KEY_K2}`, "k1");
    const ct: string = encrypt({ token: "alpha" });

    // Retire k1 from the keyring.
    setKeyring(`k2=${KEY_K2}`, "k2");
    expect(() => decrypt(ct)).toThrow(/Unknown encryption keyId "k1"/);
  });
});

describe("decrypt error handling", () => {
  beforeEach(() => {
    setKeyring(`k1=${KEY_K1}`, "k1");
  });

  it("throws on wrong segment count", () => {
    expect(() => decrypt("not-valid")).toThrow(/expected v1:keyId:iv:authTag:ct/);
    expect(() => decrypt("a:b:c")).toThrow(/expected v1:keyId:iv:authTag:ct/);
  });

  it("throws on unsupported version", () => {
    expect(() => decrypt("v0:k1:aabbcc:ddeeff:Zg==")).toThrow(
      /Unsupported ciphertext version "v0"/,
    );
  });

  it("throws on tampered ciphertext", () => {
    const ct: string = encrypt({ key: "original" });
    const parts: string[] = ct.split(":");
    parts[4] = Buffer.from("tampered-data").toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });

  it("throws on invalid IV length", () => {
    expect(() =>
      decrypt(`v1:k1:aabb:${"cd".repeat(16)}:Zg==`),
    ).toThrow(/Invalid IV length/);
  });

  it("throws on unknown keyId in ciphertext header", () => {
    const fakeCt: string = `v1:kZ:${"a".repeat(24)}:${"b".repeat(32)}:Zg==`;
    expect(() => decrypt(fakeCt)).toThrow(/Unknown encryption keyId "kZ"/);
  });
});

describe("keyring validation", () => {
  afterEach(() => {
    setKeyring(`k1=${KEY_K1}`, "k1");
  });

  it("throws when keyring env is missing", () => {
    setKeyring(undefined, "k1");
    expect(() => encrypt({ key: "x" })).toThrow(/CREDENTIAL_ENCRYPTION_KEYRING is required/);
  });

  it("throws when active key id is missing", () => {
    setKeyring(`k1=${KEY_K1}`, undefined);
    expect(() => encrypt({ key: "x" })).toThrow(/CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID is required/);
  });

  it("throws when active key id is not in keyring", () => {
    setKeyring(`k1=${KEY_K1}`, "k99");
    expect(() => encrypt({ key: "x" })).toThrow(
      /is not present in CREDENTIAL_ENCRYPTION_KEYRING/,
    );
  });

  it("throws on malformed keyring entry", () => {
    setKeyring("noequalsign", "k1");
    expect(() => encrypt({ key: "x" })).toThrow(/invalid entry/);
  });

  it("throws on wrong key length", () => {
    setKeyring("k1=tooshort", "k1");
    expect(() => encrypt({ key: "x" })).toThrow(/64-character hex string/);
  });

  it("throws on invalid keyId characters", () => {
    setKeyring(`bad id=${KEY_K1}`, "bad id");
    expect(() => encrypt({ key: "x" })).toThrow(/invalid keyId/);
  });

  it("throws on duplicate keyId", () => {
    setKeyring(`k1=${KEY_K1},k1=${KEY_K2}`, "k1");
    expect(() => encrypt({ key: "x" })).toThrow(/duplicate keyId "k1"/);
  });
});

describe("inspectCiphertextKeyId", () => {
  beforeEach(() => {
    setKeyring(`k1=${KEY_K1},k2=${KEY_K2}`, "k2");
  });

  it("returns the keyId without decrypting", () => {
    const ct: string = encrypt({ key: "x" });
    expect(inspectCiphertextKeyId(ct)).toBe("k2");
  });

  it("throws on non-v1 inputs", () => {
    expect(() => inspectCiphertextKeyId("nope")).toThrow();
    expect(() => inspectCiphertextKeyId("v0:k1:a:b:c")).toThrow();
  });
});

describe("extractKeyPreview", () => {
  it("returns first 5 + last 5 for long keys", () => {
    expect(extractKeyPreview({ key: "sk-abcdefghijklmnop" })).toBe("sk-ab…lmnop");
  });

  it("returns last 4 for short keys (4-10 chars)", () => {
    expect(extractKeyPreview({ key: "abcdef" })).toBe("…cdef");
  });

  it("returns fallback for very short keys", () => {
    expect(extractKeyPreview({ key: "ab" })).toBe("…????");
  });

  it("returns fallback when no recognized key field", () => {
    expect(extractKeyPreview({ foo: "bar" })).toBe("…????");
  });

  it("reads token field", () => {
    expect(extractKeyPreview({ token: "bearer-token-value-here" })).toBe("beare…-here");
  });

  it("reads password field", () => {
    expect(extractKeyPreview({ password: "my-secret-password" })).toBe("my-se…sword");
  });

  it("reads clientSecret field", () => {
    expect(extractKeyPreview({ clientSecret: "client-secret-123" })).toBe("clien…t-123");
  });

  it("prefers token over key", () => {
    // Lookup order is token → key → password → ...; with both set, token wins.
    // "the-token-yy" → first 5 = "the-t", last 5 = "en-yy".
    expect(extractKeyPreview({ key: "the-key-value-xx", token: "the-token-yy" })).toBe(
      "the-t…en-yy",
    );
  });
});
