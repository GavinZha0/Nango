import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";
import pg from "pg";
import { getPostgresUrl } from "@/lib/db/postgres-url";
import { BASE_NAMES, E2E_PLACEHOLDER_KEY } from "../constants/base-resources";

/**
 * Seed Layer 0 (LLM Credential) and Layer 1 (Supervisor, General, Evaluator Agents)
 * into the database via the authenticated Admin API context.
 *
 * Idempotent: 409 Conflict (e.g. supervisor or credential already exists) is safely tolerated.
 * CONTRACT: All base agents are created with visibility: "public" so they are visible to all roles.
 */
export async function seedBaseResources(request: APIRequestContext): Promise<void> {
  // 1. Base LLM Credential: check existing first to prevent duplicate rows
  let credId: string | undefined;
  const listCredRes = await request.get("/api/admin/credentials");
  if (listCredRes.ok()) {
    const list = (await listCredRes.json()) as Array<{ id: string; name: string }>;
    const found = list.find((c) => c.name === BASE_NAMES.llmCredential);
    if (found) credId = found.id;
  }

  if (!credId) {
    const credRes = await request.post("/api/admin/credentials", {
      data: {
        name: BASE_NAMES.llmCredential,
        type: "api_key",
        serviceType: "llm",
        provider: "openai",
        payload: { key: E2E_PLACEHOLDER_KEY },
      },
    });

    if (credRes.status() === 409) {
      const listRes = await request.get("/api/admin/credentials");
      const list = (await listRes.json()) as Array<{ id: string; name: string }>;
      const found = list.find((c) => c.name === BASE_NAMES.llmCredential);
      if (!found) throw new Error("Base LLM credential reported conflict but not found in list");
      credId = found.id;
    } else {
      expect(credRes.ok(), await credRes.text()).toBeTruthy();
      const body = (await credRes.json()) as { id: string };
      credId = body.id;
    }
  }

  // Pre-fetch existing agents to prevent duplicate rows (only supervisor has DB uniqueness)
  const existingAgentsRes = await request.get("/api/builtin-agents");
  const existingAgents: Array<{ id: string; name: string; role: string | null; visibility?: string }> =
    existingAgentsRes.ok() ? await existingAgentsRes.json() : [];

  // Helper for agent seeding with visibility: "public" & verified 409 tolerance
  async function seedAgent(data: {
    name: string;
    role: "supervisor" | "evaluator" | null;
    model: string;
    modelProvider: string;
    credentialId: string;
    enabled: boolean;
    visibility: "public";
  }) {
    // If a public agent with this name already exists, safe to reuse
    const alreadyExists = existingAgents.some(
      (a) => a.name === data.name && a.visibility === "public",
    );
    if (alreadyExists) return;

    const res = await request.post("/api/builtin-agents", { data });
    if (res.status() === 409) {
      // Role uniqueness conflict: confirm the agent exists in DB, otherwise throw
      const verifyRes = await request.get("/api/builtin-agents");
      const verifyList = verifyRes.ok()
        ? ((await verifyRes.json()) as Array<{ id: string; name: string; role: string | null }>)
        : [];
      const confirmed = verifyList.some(
        (a) => (data.role === "supervisor" && a.role === "supervisor") || a.name === data.name,
      );
      if (!confirmed) {
        throw new Error(`Agent ${data.name} reported 409 conflict but was not found in agent list`);
      }
      return;
    }
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  // 2. Nango Supervisor Agent
  await seedAgent({
    name: BASE_NAMES.supervisorAgent,
    role: "supervisor",
    model: "gpt-4o",
    modelProvider: "openai",
    credentialId: credId,
    enabled: true,
    visibility: "public",
  });

  // 3. Base General Agent
  await seedAgent({
    name: BASE_NAMES.generalAgent,
    role: null,
    model: "gpt-4o",
    modelProvider: "openai",
    credentialId: credId,
    enabled: true,
    visibility: "public",
  });

  // 4. Base Evaluator Agent
  await seedAgent({
    name: BASE_NAMES.evaluatorAgent,
    role: "evaluator",
    model: "gpt-4o",
    modelProvider: "openai",
    credentialId: credId,
    enabled: true,
    visibility: "public",
  });

  // 5. Base Daily Schedule
  await seedBaseSchedule(request);
}

/**
 * Seed a recurring schedule bound to Base-General-e2e-Agent.
 * Can be called with either admin or regular user request context.
 * Idempotent: checks for existing schedule with BASE_NAMES.dailySchedule first.
 */
export async function seedBaseSchedule(request: APIRequestContext): Promise<void> {
  const listRes = await request.get("/api/schedules");
  if (listRes.ok()) {
    const list = (await listRes.json()) as Array<{ name: string | null }>;
    if (list.some((s) => s.name === BASE_NAMES.dailySchedule)) {
      return;
    }
  }

  const agentsRes = await request.get("/api/builtin-agents");
  if (!agentsRes.ok()) return;
  const agents = (await agentsRes.json()) as Array<{ id: string; name: string }>;
  const generalAgent = agents.find((a) => a.name === BASE_NAMES.generalAgent);
  if (!generalAgent) {
    throw new Error(`Cannot seed schedule: ${BASE_NAMES.generalAgent} not found`);
  }

  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  const createRes = await request.post("/api/schedules", {
    data: {
      name: BASE_NAMES.dailySchedule,
      entityId: generalAgent.id,
      entityKind: "agent",
      sourceLabel: BASE_NAMES.generalAgent,
      task: "Summarize daily workspace activities",
      startAt: tomorrow,
      intervalValue: 1,
      intervalUnit: "day",
      enabled: false,
    },
  });
  expect(createRes.ok(), await createRes.text()).toBeTruthy();
}

/**
 * Seed read & unread base notifications for the given user directly via DB.
 * Idempotent: checks if notifications with the base titles already exist.
 */
export async function seedBaseNotifications(userEmail: string): Promise<void> {
  const { Client } = pg;
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();
    // 1. Resolve user ID
    const userRes = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
      [userEmail],
    );
    if (userRes.rows.length === 0) {
      throw new Error(`Cannot seed notifications: user ${userEmail} not found`);
    }
    const userId = userRes.rows[0].id;

    // 2. Check existing notifications
    const existing = await client.query<{ title: string }>(
      `SELECT title FROM notification WHERE owner_id = $1 AND title IN ($2, $3)`,
      [userId, BASE_NAMES.unreadNotification, BASE_NAMES.readNotification],
    );
    const existingTitles = new Set(existing.rows.map((r) => r.title));

    // 3. Insert unread completed notification if missing
    if (!existingTitles.has(BASE_NAMES.unreadNotification)) {
      await client.query(
        `INSERT INTO notification (owner_id, kind, title, body, full_body, source_label, task, initiator, read_at)
         VALUES ($1, 'run_completed', $2, $3, $4, $5, $6, 'user', NULL)`,
        [
          userId,
          BASE_NAMES.unreadNotification,
          "Daily workspace summary completed successfully.",
          "Daily workspace summary completed successfully with 0 errors.",
          BASE_NAMES.generalAgent,
          "Summarize daily workspace activities",
        ],
      );
    }

    // 4. Insert read failed notification if missing
    if (!existingTitles.has(BASE_NAMES.readNotification)) {
      await client.query(
        `INSERT INTO notification (owner_id, kind, title, body, full_body, source_label, task, initiator, read_at)
         VALUES ($1, 'run_failed', $2, $3, $4, $5, $6, 'user', NOW())`,
        [
          userId,
          BASE_NAMES.readNotification,
          "Nightly data sync encountered a timeout.",
          "Nightly data sync encountered a timeout after 3 retries.",
          BASE_NAMES.generalAgent,
          "Sync external data sources",
        ],
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * Create an ephemeral notification for write/delete lifecycle tests.
 * Returns the created notification id.
 */
export async function createEphemeralNotification(
  userEmail: string,
  title: string,
): Promise<string> {
  const { Client } = pg;
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();
    const userRes = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
      [userEmail],
    );
    if (userRes.rows.length === 0) {
      throw new Error(`Cannot create notification: user ${userEmail} not found`);
    }
    const userId = userRes.rows[0].id;
    const res = await client.query<{ id: string }>(
      `INSERT INTO notification (owner_id, kind, title, body, full_body, source_label, task, initiator, read_at)
       VALUES ($1, 'run_completed', $2, $3, $4, $5, $6, 'user', NULL)
       RETURNING id`,
      [
        userId,
        title,
        "Ephemeral test notification body.",
        "Ephemeral test notification full body content.",
        BASE_NAMES.generalAgent,
        "Run automated ephemeral task",
      ],
    );
    return res.rows[0].id;
  } finally {
    await client.end();
  }
}

