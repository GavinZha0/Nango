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
import { isStdioMcpAllowed } from "@/lib/mcp/stdio-spawn.server";

export interface BuiltinInfraSeedValues {
  sandboxUrl: string;
  senseVoiceUrl: string;
  playwrightMcp: {
    type: "http" | "stdio";
    url: string;
    command: string | null;
    args: string[] | null;
  } | null;
}

export function resolveBuiltinInfraSeedValues(): BuiltinInfraSeedValues {
  const isDesktop = process.env.NANGO_DESKTOP === "1";
  const sandboxUrl =
    process.env.NANGO_SEED_SANDBOX_URL?.trim() ||
    (isDesktop ? "http://127.0.0.1:8194" : "http://sandbox:8194");
  const senseVoiceUrl =
    process.env.NANGO_SEED_SENSEVOICE_URL?.trim() ||
    (isDesktop ? "http://127.0.0.1:10085" : "http://sensevoice:8000");

  if (!isDesktop) {
    return {
      sandboxUrl,
      senseVoiceUrl,
      playwrightMcp: {
        type: "http",
        url: "http://playwright:8931/mcp",
        command: null,
        args: null,
      },
    };
  }

  // Respect explicit `NANGO_ALLOW_STDIO_MCP=false` in desktop mode so we never
  // seed a `stdio` MCP server row that the runtime refuses to spawn.
  if (!isStdioMcpAllowed()) {
    return {
      sandboxUrl,
      senseVoiceUrl,
      playwrightMcp: null,
    };
  }

  return {
    sandboxUrl,
    senseVoiceUrl,
    playwrightMcp: {
      type: "stdio",
      url: "",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--browser", "chrome"],
    },
  };
}

export async function seedBuiltinInfrastructure(): Promise<void> {
  try {
    const seedValues = resolveBuiltinInfraSeedValues();

    // 1. Seed Dify Sandbox Credential
    const existingSandbox = await db
      .select({ id: CredentialTable.id })
      .from(CredentialTable)
      .where(eq(CredentialTable.provider, "dify-sandbox"))
      .limit(1);

    if (existingSandbox.length === 0) {
      const payload = {
        host: seedValues.sandboxUrl,
        apiKey: "dify-sandbox",
      };
      await db.insert(CredentialTable).values({
        name: "Dify Sandbox",
        type: "api_key",
        serviceType: "integration",
        provider: "dify-sandbox",
        restUrl: seedValues.sandboxUrl,
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
        host: seedValues.senseVoiceUrl,
        apiKey: "MySuperSafeApiKey",
      };
      await db.insert(CredentialTable).values({
        name: "SenseVoice",
        type: "api_key",
        serviceType: "voice",
        provider: "sensevoice",
        restUrl: seedValues.senseVoiceUrl,
        encryptedPayload: encrypt(payload),
        metadata: { keyPreview: "MySuperSafeApiKey" },
        enabled: true,
        createdBy: null,
      });
      console.log("[bootstrap] Seeded default SenseVoice credential");
    }

    // 3. Seed Playwright MCP Server
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
        console.log("[bootstrap] Seeded default Playwright MCP server");
      }
    }

    // Invalidate credential cache so newly seeded credentials are immediately visible to in-process callers
    invalidateCredentialCache();
  } catch (err) {
    console.error(`[bootstrap] Failed to seed infrastructure: ${err instanceof Error ? err.message : String(err)}`);
  }
}

