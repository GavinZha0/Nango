/**
 * Built-in Infrastructure Seeder.
 *
 * Seeds default credentials (`Dify Sandbox`, `SenseVoice`) and default
 * MCP servers (`Playwright`) during server bootstrap so built-in
 * infrastructure is zero-config ready out of the box.
 */

import "server-only";

import { db } from "@/lib/db";
import { CredentialTable, McpServerTable } from "@/lib/db/schema";
import { encrypt } from "./crypto";
import { eq } from "drizzle-orm";
import { invalidateCredentialCache } from "@/lib/credentials/lookup";

export async function seedBuiltinInfrastructure(): Promise<void> {
  try {
    // 1. Seed Dify Sandbox Credential
    const existingSandbox = await db
      .select({ id: CredentialTable.id })
      .from(CredentialTable)
      .where(eq(CredentialTable.provider, "dify-sandbox"))
      .limit(1);

    if (existingSandbox.length === 0) {
      const payload = {
        host: "http://sandbox:8194",
        apiKey: "dify-sandbox",
      };
      await db.insert(CredentialTable).values({
        name: "Dify Sandbox",
        type: "api_key",
        serviceType: "integration",
        provider: "dify-sandbox",
        restUrl: "http://sandbox:8194",
        encryptedPayload: encrypt(payload),
        metadata: { keyPreview: "dify-sandbox" },
        enabled: true,
        createdBy: null,
      });
      console.log("[bootstrap] Seeded default Dify Sandbox credential");
    }

    // 2. Seed SenseVoice Credential
    const existingSenseVoice = await db
      .select({ id: CredentialTable.id })
      .from(CredentialTable)
      .where(eq(CredentialTable.provider, "sensevoice"))
      .limit(1);

    if (existingSenseVoice.length === 0) {
      const payload = {
        host: "http://sensevoice:8000",
        apiKey: "MySuperSafeApiKey",
      };
      await db.insert(CredentialTable).values({
        name: "SenseVoice",
        type: "api_key",
        serviceType: "voice",
        provider: "sensevoice",
        restUrl: "http://sensevoice:8000",
        encryptedPayload: encrypt(payload),
        metadata: { keyPreview: "MySuperSafeApiKey" },
        enabled: true,
        createdBy: null,
      });
      console.log("[bootstrap] Seeded default SenseVoice credential");
    }

    // 3. Seed Playwright MCP Server
    const existingPlaywright = await db
      .select({ id: McpServerTable.id })
      .from(McpServerTable)
      .where(eq(McpServerTable.name, "Playwright"))
      .limit(1);

    if (existingPlaywright.length === 0) {
      await db.insert(McpServerTable).values({
        name: "Playwright",
        description: "Built-in Playwright Browser Automation MCP Server",
        type: "http",
        url: "http://playwright:8931/mcp",
        visibility: "public",
        enabled: true,
        credentialId: null,
        createdBy: null,
      });
      console.log("[bootstrap] Seeded default Playwright MCP server");
    }

    // Invalidate credential cache so newly seeded credentials are immediately visible to in-process callers
    invalidateCredentialCache();
  } catch (err) {
    console.error(`[bootstrap] Failed to seed infrastructure: ${err instanceof Error ? err.message : String(err)}`);
  }
}

