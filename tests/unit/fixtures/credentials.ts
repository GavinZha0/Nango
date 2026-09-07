/**
 * Shared test fixtures and factory helpers for Credentials.
 */

import type { CredentialEntity } from "@/lib/db/schema";

let credSeq = 1;

function makeSeqUuid(prefix: string, seq: number): string {
  const hex = seq.toString(16).padStart(12, "0");
  return `${prefix}-0000-4000-8000-${hex}`;
}

export function createMockCredential(
  overrides: Partial<CredentialEntity> = {},
): CredentialEntity {
  const seq = credSeq++;
  return {
    id: overrides.id ?? makeSeqUuid("01918a3d", seq),
    name: `Credential ${seq}`,
    type: "llm",
    serviceType: "openai",
    provider: "openai",
    encryptedPayload: "v1:k1:00112233:aabbccdd:encrypted==",
    enabled: true,
    metadata: null,
    restUrl: null,
    aguiUrl: null,
    createdBy: "user-admin-1",
    updatedBy: "user-admin-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}
