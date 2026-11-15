/**
 * Built-in Infrastructure Seeder.
 *
 * Seeds infrastructure credentials (`Dify Sandbox`, `SenseVoice`) and
 * MCP servers (`Playwright`) during server bootstrap ONLY when explicitly
 * requested via `NANGO_SEED_*` environment variables (e.g. from docker-compose.yaml).
 * Without those variables, no default endpoints or credentials are assumed.
 */

import "server-only";

import { db } from "@/lib/db";
import { CredentialTable, McpServerTable } from "@/lib/db/schema";
import { encrypt } from "./crypto";
import { eq } from "drizzle-orm";
import { invalidateCredentialCache } from "@/lib/credentials/lookup";

export interface BuiltinInfraCredentialSeed {
  url: string;
  apiKey: string;
}

export interface BuiltinInfraSeedValues {
  sandbox: BuiltinInfraCredentialSeed | null;
  senseVoice: BuiltinInfraCredentialSeed | null;
  playwrightMcp: {
    type: "http";
    url: string;
    command: null;
    args: null;
  } | null;
}

export function resolveBuiltinInfraSeedValues(): BuiltinInfraSeedValues {
  const sandboxUrl = process.env.NANGO_SEED_SANDBOX_URL?.trim();
  const senseVoiceUrl = process.env.NANGO_SEED_SENSEVOICE_URL?.trim();
  const playwrightMcpUrl = process.env.NANGO_SEED_PLAYWRIGHT_MCP_URL?.trim();

  return {
    sandbox: sandboxUrl
      ? {
          url: sandboxUrl,
          apiKey: process.env.NANGO_SEED_SANDBOX_API_KEY?.trim() || "",
        }
      : null,
    senseVoice: senseVoiceUrl
      ? {
          url: senseVoiceUrl,
          apiKey: process.env.NANGO_SEED_SENSEVOICE_API_KEY?.trim() || "",
        }
      : null,
    playwrightMcp: playwrightMcpUrl
      ? {
          type: "http",
          url: playwrightMcpUrl,
          command: null,
          args: null,
        }
      : null,
  };
}

export async function seedBuiltinInfrastructure(): Promise<void> {
  try {
    const seedValues = resolveBuiltinInfraSeedValues();
    if (!seedValues.sandbox && !seedValues.senseVoice && !seedValues.playwrightMcp) {
      return;
    }

    let seededAnyCredential = false;

    // 1. Seed Dify Sandbox Credential (only when NANGO_SEED_SANDBOX_URL is set)
    if (seedValues.sandbox) {
      const existingSandbox = await db
        .select({ id: CredentialTable.id })
        .from(CredentialTable)
        .where(eq(CredentialTable.provider, "dify-sandbox"))
        .limit(1);

      if (existingSandbox.length === 0) {
        const payload = {
          host: seedValues.sandbox.url,
          apiKey: seedValues.sandbox.apiKey,
        };
        await db.insert(CredentialTable).values({
          name: "Dify Sandbox",
          type: "api_key",
          serviceType: "integration",
          provider: "dify-sandbox",
          restUrl: seedValues.sandbox.url,
          encryptedPayload: encrypt(payload),
          metadata: seedValues.sandbox.apiKey
            ? { keyPreview: seedValues.sandbox.apiKey }
            : null,
          enabled: true,
          createdBy: null,
        });
        seededAnyCredential = true;
        console.log("[bootstrap] Seeded Dify Sandbox credential from NANGO_SEED_SANDBOX_URL");
      }
    }

    // 2. Seed SenseVoice Credential (only when NANGO_SEED_SENSEVOICE_URL is set)
    if (seedValues.senseVoice) {
      const existingSenseVoice = await db
        .select({ id: CredentialTable.id })
        .from(CredentialTable)
        .where(eq(CredentialTable.provider, "sensevoice"))
        .limit(1);

      if (existingSenseVoice.length === 0) {
        const payload = {
          host: seedValues.senseVoice.url,
          apiKey: seedValues.senseVoice.apiKey,
        };
        await db.insert(CredentialTable).values({
          name: "SenseVoice",
          type: "api_key",
          serviceType: "voice",
          provider: "sensevoice",
          restUrl: seedValues.senseVoice.url,
          encryptedPayload: encrypt(payload),
          metadata: seedValues.senseVoice.apiKey
            ? { keyPreview: seedValues.senseVoice.apiKey }
            : null,
          enabled: true,
          createdBy: null,
        });
        seededAnyCredential = true;
        console.log("[bootstrap] Seeded SenseVoice credential from NANGO_SEED_SENSEVOICE_URL");
      }
    }

    // 3. Seed Playwright MCP Server (only when NANGO_SEED_PLAYWRIGHT_MCP_URL is set)
    if (seedValues.playwrightMcp) {
      const existingPlaywright = await db
        .select({ id: McpServerTable.id })
        .from(McpServerTable)
        .where(eq(McpServerTable.name, "Playwright"))
        .limit(1);

      if (existingPlaywright.length === 0) {
        await db.insert(McpServerTable).values({
          name: "Playwright",
          description: "Built-in Playwright Browser Automation MCP Server",
          type: seedValues.playwrightMcp.type,
          url: seedValues.playwrightMcp.url,
          command: seedValues.playwrightMcp.command,
          args: seedValues.playwrightMcp.args,
          visibility: "public",
          enabled: true,
          credentialId: null,
          createdBy: null,
        });
        console.log("[bootstrap] Seeded Playwright MCP server from NANGO_SEED_PLAYWRIGHT_MCP_URL");
      }
    }

    // Invalidate credential cache so newly seeded credentials are immediately visible to in-process callers
    if (seededAnyCredential) {
      invalidateCredentialCache();
    }
  } catch (err) {
    console.error(`[bootstrap] Failed to seed infrastructure: ${err instanceof Error ? err.message : String(err)}`);
  }
}

