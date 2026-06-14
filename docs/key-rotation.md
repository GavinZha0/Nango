# Credential Encryption Key Rotation

> Scope: AES-256-GCM keys used by `src/lib/credentials/crypto.ts` to encrypt rows in the
> `credential` table. Not session cookies — those use `BETTER_AUTH_SECRET`
> and are rotated independently.

## 1. Background

Every credential row is stored as:

```
v1:<keyId>:<iv_hex>:<authTag_hex>:<ciphertext_base64>
```

`keyId` selects which 32-byte key from the keyring decrypts the row. The
keyring is configured via two environment variables:

| Variable | Purpose |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEYRING` | `<keyId>=<64-hex>` entries, comma-separated. **Every key still referenced by any row must remain here**, otherwise that row becomes undecryptable. |
| `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID` | The keyId used to encrypt **new** rows. |

This separation is what makes zero-downtime rotation possible: a new key
can be added to the keyring before any row uses it, and an old key can
remain in the keyring long after `ACTIVE_KEY_ID` has flipped away from
it. Rows are upgraded lazily — or in a single batch job — without ever
losing decryption capability.

## 2. Routine rotation (recommended every 6–12 months)

The procedure assumes you currently have a single key `k1` and want to
rotate to a freshly generated `k2`.

### Step 1 — Generate the new key

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 2 — Add the new key to the keyring; redeploy

```diff
- CREDENTIAL_ENCRYPTION_KEYRING=k1=<old-hex>
+ CREDENTIAL_ENCRYPTION_KEYRING=k1=<old-hex>,k2=<new-hex>
  CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=k1
```

After the rolling restart every instance can decrypt with either key.
**Nothing visible changes yet** — rows are still encrypted with `k1`.

### Step 3 — Flip `ACTIVE_KEY_ID`; redeploy

```diff
  CREDENTIAL_ENCRYPTION_KEYRING=k1=<old-hex>,k2=<new-hex>
- CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=k1
+ CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=k2
```

From this moment **every credential write produces a `v1:k2:…` row**.
Rows still tagged `k1` continue to decrypt fine because `k1` is still in
the keyring.

### Step 4 — Re-encrypt historical rows (optional but recommended)

You can either:

**(a)** Wait for natural rewrites (every credential update touches a row
       and re-encrypts it with the active key). Eventually `k1`-tagged
       rows decline to zero. Use the audit query in §4 to track progress.

**(b)** Force a one-shot batch re-encrypt: read each row, decrypt with
       its existing key, re-encrypt with the active key, write back.
       Simplest implementation today is to run a small ad-hoc Node
       script using `decrypt()` + `encrypt()` from `@/lib/credentials/crypto`; this
       can be added when the row count is large enough to warrant it.

### Step 5 — Retire the old key

Once §4's audit query reports zero rows tagged `k1`:

```diff
- CREDENTIAL_ENCRYPTION_KEYRING=k1=<old-hex>,k2=<new-hex>
+ CREDENTIAL_ENCRYPTION_KEYRING=k2=<new-hex>
  CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=k2
```

Redeploy. Destroy the old key material in your secret store (KMS / Vault
/ password manager).

## 3. Emergency rotation (suspected key compromise)

If `k1` is believed leaked, the priority is to limit ongoing exposure
and then re-encrypt as fast as possible:

1. Run **steps 2 and 3 immediately** so all new writes use a fresh key.
2. Run a forced re-encryption (§4 step 4 option b). Until it completes,
   any row still tagged `k1` is recoverable by anyone holding the leaked
   key.
3. As soon as the audit query reports zero `k1` rows, run **step 5** to
   retire `k1` from the keyring.

Each step is a redeploy and takes minutes; the slow part is option (b)
re-encryption, which is bounded by `O(rows)` and a few DB round-trips
per row.

## 4. Audit: count rows per key

```typescript
// Pseudo-code for audit query:
rows = db.selectAll(CredentialTable);
counts = {};
for row in rows:
    keyId = inspectCiphertextKeyId(row.encryptedPayload);
    counts[keyId] = (counts[keyId] || 0) + 1;
print(counts);
```

## 5. Failure modes and safeguards

| Failure | What happens | Mitigation |
|---|---|---|
| `ACTIVE_KEY_ID` not in keyring | App fails to start (loud error). | Caught by validation in `loadKeyring()`. |
| Key removed from keyring while rows still reference it | Decrypt throws `Unknown encryption keyId "kX"`. Affected credential is unusable until you put `kX` back. | Always run the audit query before §2 step 5. |
| Wrong key length / non-hex / duplicate keyId | App fails to start. | Validated at parse time. |
| Ciphertext tampered in DB | `decrypt()` throws auth-tag failure. | GCM tag protects integrity end-to-end. |
| Multiple instances out of sync after a redeploy | Some can decrypt new rows, some cannot. | Roll deploys one revision at a time and verify health checks before promoting. |

---

## 6. Implementation Details and Quirks

### Keyring Validation (`src/lib/credentials/crypto.ts`)
- **Quirk (Lazy validation)**: Keyring validation occurs lazily (on first use) rather than at module-load. This is because Next.js's "Collecting page data" build step often imports API route modules without all runtime environment variables set, which would otherwise crash the build.
- **Security**: Every key in the keyring is strictly validated to be exactly 32 bytes (256 bits). The active `keyId` must reference an entry that actually exists in the ring. If any rule is violated, the app will throw and refuse to start, rather than silently falling back.
