/**
 * Infrastructure Credentials Seeder.
 *
 * Seeds default credentials (`Dify Sandbox` and `SenseVoice`) when
 * the first Admin user registers, so built-in infrastructure is
 * zero-config ready out of the box.
 */

import "server-only";

import { db } from "@/lib/db";
import { CredentialTable } from "@/lib/db/schema";
import { encrypt } from "./crypto";
import { eq } from "drizzle-orm";

export async function seedInitialInfrastructureCredentials(adminUserId: string): Promise<void> {
  try {
    // 1. Seed Dify Sandbox Credential
    const existingSandbox = await db
      .select({ id: CredentialTable.id })
      .from(CredentialTable)
      .where(eq(CredentialTable.provider, "dify-sandbox"))
      .limit(1);

    if (existingSandbox.length === 0) {
      const payload = {
        host: "http://dify-sandbox:8194",
        apiKey: "dify-sandbox",
      };
      await db.insert(CredentialTable).values({
        name: "Dify Sandbox",
        type: "api_key",
        serviceType: "integration",
        provider: "dify-sandbox",
        restUrl: "http://dify-sandbox:8194",
        encryptedPayload: encrypt(payload),
        metadata: { keyPreview: "dify-sandbox" },
        enabled: true,
        createdBy: adminUserId,
      });
      console.log(`[credentials] Seeded default Dify Sandbox credential for admin (${adminUserId})`);
    }

    // 2. Seed DuckDB Engine Credential
    const existingDuckdbEngine = await db
      .select({ id: CredentialTable.id })
      .from(CredentialTable)
      .where(eq(CredentialTable.provider, "duckdb-engine"))
      .limit(1);

    if (existingDuckdbEngine.length === 0) {
      const payload = {
        host: "http://duckdb-engine:8526",
        apiKey: "my-local-duckdb-engine-secret",
      };
      await db.insert(CredentialTable).values({
        name: "DuckDB Engine",
        type: "api_key",
        serviceType: "integration",
        provider: "duckdb-engine",
        restUrl: "http://duckdb-engine:8526",
        encryptedPayload: encrypt(payload),
        metadata: { keyPreview: "my-local-duckdb-engine-secret" },
        enabled: true,
        createdBy: adminUserId,
      });
      console.log(`[credentials] Seeded default DuckDB Engine credential for admin (${adminUserId})`);
    }

    // 2. Seed SenseVoice Credential
    const existingSenseVoice = await db
      .select({ id: CredentialTable.id })
      .from(CredentialTable)
      .where(eq(CredentialTable.provider, "sensevoice"))
      .limit(1);

    let senseVoiceId: string | null = existingSenseVoice[0]?.id ?? null;

    if (!senseVoiceId) {
      const payload = {
        host: "http://sensevoice:8000",
        apiKey: "MySuperSafeApiKey",
      };
      const [inserted] = await db.insert(CredentialTable).values({
        name: "SenseVoice",
        type: "api_key",
        serviceType: "voice",
        provider: "sensevoice",
        restUrl: "http://sensevoice:8000",
        encryptedPayload: encrypt(payload),
        metadata: { keyPreview: "MySuperSafeApiKey" },
        enabled: true,
        createdBy: adminUserId,
      }).returning({ id: CredentialTable.id });
      senseVoiceId = inserted.id;
      console.log(`[credentials] Seeded default SenseVoice credential for admin (${adminUserId})`);
    }

    // Bind SenseVoice credential ID to admin user's STT profile settings by default
    if (senseVoiceId) {
      const { UserTable } = await import("@/lib/db/schema");
      await db
        .update(UserTable)
        .set({ sttCredentialId: senseVoiceId })
        .where(eq(UserTable.id, adminUserId));
      console.log(`[credentials] Set admin user (${adminUserId}) STT default credential to SenseVoice (${senseVoiceId})`);
    }

    // Invalidate credential cache so newly seeded credentials are immediately visible to in-process callers
    const { invalidateCredentialCache } = await import("@/lib/credentials/lookup");
    invalidateCredentialCache();
  } catch (err) {
    console.error(`[credentials] Failed to seed infrastructure credentials: ${err instanceof Error ? err.message : String(err)}`);
  }
}
