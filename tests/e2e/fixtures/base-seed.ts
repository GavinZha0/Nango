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
  const credList: Array<{ id: string; name: string }> = listCredRes.ok()
    ? await listCredRes.json()
    : [];

  const foundLlm = credList.find((c) => c.name === BASE_NAMES.llmCredential);
  if (foundLlm) credId = foundLlm.id;

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

  // 1b. Base DataSource Credential: check existing first to prevent duplicate rows
  let dsCredId: string | undefined;
  const foundDs = credList.find((c) => c.name === BASE_NAMES.datasourceCredential);
  if (foundDs) dsCredId = foundDs.id;

  if (!dsCredId) {
    const dsCredRes = await request.post("/api/admin/credentials", {
      data: {
        name: BASE_NAMES.datasourceCredential,
        type: "basic_auth",
        serviceType: "datasource",
        provider: "postgres",
        payload: { username: "postgres", password: "password" },
      },
    });

    if (dsCredRes.status() === 409) {
      const listRes = await request.get("/api/admin/credentials");
      const list = (await listRes.json()) as Array<{ id: string; name: string }>;
      const found = list.find((c) => c.name === BASE_NAMES.datasourceCredential);
      if (!found) throw new Error("Base DataSource credential reported conflict but not found in list");
      dsCredId = found.id;
    } else {
      expect(dsCredRes.ok(), await dsCredRes.text()).toBeTruthy();
    }
  }

  // 1c. Base SSH Credential: check existing first to prevent duplicate rows
  let sshCredId: string | undefined;
  const foundSsh = credList.find((c) => c.name === BASE_NAMES.sshCredential);
  if (foundSsh) sshCredId = foundSsh.id;

  if (!sshCredId) {
    const sshCredRes = await request.post("/api/admin/credentials", {
      data: {
        name: BASE_NAMES.sshCredential,
        type: "basic_auth",
        serviceType: "integration",
        provider: "ssh",
        payload: { username: "ubuntu", password: "mockpassword" },
      },
    });

    if (sshCredRes.status() === 409) {
      const listRes = await request.get("/api/admin/credentials");
      const list = (await listRes.json()) as Array<{ id: string; name: string }>;
      const found = list.find((c) => c.name === BASE_NAMES.sshCredential);
      if (!found) throw new Error("Base SSH credential reported conflict but not found in list");
      sshCredId = found.id;
    } else {
      expect(sshCredRes.ok(), await sshCredRes.text()).toBeTruthy();
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

/**
 * Seed a read-only Base MCP server with pre-populated tools snapshot.
 * Idempotent: checks for existing public server with BASE_NAMES.mcpServer first.
 */
export async function seedBaseMcpServer(adminEmail: string): Promise<void> {
  const { Client } = pg;
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();

    // 1. Check if base MCP server already exists with visibility: "public"
    const checkRes = await client.query(
      `SELECT id FROM mcp_server WHERE name = $1 AND visibility = 'public' LIMIT 1`,
      [BASE_NAMES.mcpServer],
    );
    if (checkRes.rows.length > 0) return;

    // 2. Resolve admin user ID
    const userRes = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
      [adminEmail],
    );
    if (userRes.rows.length === 0) {
      throw new Error(`Cannot seed MCP server: user ${adminEmail} not found`);
    }
    const adminId = userRes.rows[0].id;

    // 3. Pre-populated mock tools snapshot for deterministic UI testing
    const mockTools = JSON.stringify([
      {
        name: "echo_tool",
        description: "Echo test tool for E2E verification",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Message to echo" },
          },
          required: ["message"],
        },
      },
    ]);

    await client.query(
      `INSERT INTO mcp_server (name, type, url, enabled, visibility, tools, server_name, server_version, server_description, created_by)
       VALUES ($1, 'http', 'https://example.com/mcp', false, 'public', $2, 'mock-server', '1.0.0', 'Mock MCP Server for E2E testing', $3)`,
      [BASE_NAMES.mcpServer, mockTools, adminId],
    );
  } finally {
    await client.end();
  }
}

/**
 * Seed a read-only Base Data Source bound to Base-Datasource-e2e-Credential.
 * Idempotent: checks for existing public data source with BASE_NAMES.dataSource first.
 */
export async function seedBaseDataSource(adminEmail: string): Promise<void> {
  const { Client } = pg;
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();

    // 1. Check if base data source already exists with visibility: "public"
    const checkRes = await client.query(
      `SELECT id FROM data_source WHERE name = $1 AND visibility = 'public' LIMIT 1`,
      [BASE_NAMES.dataSource],
    );
    if (checkRes.rows.length > 0) return;

    // 2. Resolve admin user ID
    const userRes = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
      [adminEmail],
    );
    if (userRes.rows.length === 0) {
      throw new Error(`Cannot seed data source: user ${adminEmail} not found`);
    }
    const adminId = userRes.rows[0].id;

    // 3. Resolve base datasource credential ID
    const credRes = await client.query<{ id: string }>(
      `SELECT id FROM credential WHERE name = $1 LIMIT 1`,
      [BASE_NAMES.datasourceCredential],
    );
    if (credRes.rows.length === 0) {
      throw new Error(
        `Cannot seed data source: credential ${BASE_NAMES.datasourceCredential} not found`,
      );
    }
    const credId = credRes.rows[0].id;

    // 4. Insert base data source (enabled: false for zero side effects, public visibility, read_only: true)
    await client.query(
      `INSERT INTO data_source (name, description, provider, credential_id, host, port, database, params, read_only, table_allowlist, table_denylist, enabled, visibility, created_by)
       VALUES ($1, $2, 'postgres', $3, 'localhost', 5432, 'nango_test', '{}'::jsonb, true, NULL, '[]'::jsonb, false, 'public', $4)`,
      [
        BASE_NAMES.dataSource,
        "Base Postgres data source for E2E testing",
        credId,
        adminId,
      ],
    );
  } finally {
    await client.end();
  }
}

/**
 * Seed a read-only Base SSH Server bound to Base-SSH-e2e-Credential.
 * Idempotent: checks for existing public SSH server with BASE_NAMES.sshServer first.
 */
export async function seedBaseSshServer(adminEmail: string): Promise<void> {
  const { Client } = pg;
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();

    // 1. Check if base SSH server already exists with visibility: "public"
    const checkRes = await client.query(
      `SELECT id FROM ssh_server WHERE name = $1 AND visibility = 'public' LIMIT 1`,
      [BASE_NAMES.sshServer],
    );
    if (checkRes.rows.length > 0) return;

    // 2. Resolve admin user ID
    const userRes = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
      [adminEmail],
    );
    if (userRes.rows.length === 0) {
      throw new Error(`Cannot seed SSH server: user ${adminEmail} not found`);
    }
    const adminId = userRes.rows[0].id;

    // 3. Resolve base SSH credential ID
    const credRes = await client.query<{ id: string }>(
      `SELECT id FROM credential WHERE name = $1 LIMIT 1`,
      [BASE_NAMES.sshCredential],
    );
    if (credRes.rows.length === 0) {
      throw new Error(
        `Cannot seed SSH server: credential ${BASE_NAMES.sshCredential} not found`,
      );
    }
    const credId = credRes.rows[0].id;

    // 4. Insert base SSH server (enabled: false for zero side effects, public visibility)
    await client.query(
      `INSERT INTO ssh_server (name, description, credential_id, host, port, known_host_fingerprint, command_allow, command_deny, command_approve, login_shell, enabled, visibility, created_by)
       VALUES ($1, $2, $3, 'localhost', 22, 'SHA256:dGVzdGZpbmdlcnByaW50ZXhhbXBsZTEyMzQ1Njc4OTA=', NULL, '[]'::jsonb, '[]'::jsonb, true, false, 'public', $4)`,
      [
        BASE_NAMES.sshServer,
        "Base SSH server for E2E testing",
        credId,
        adminId,
      ],
    );
  } finally {
    await client.end();
  }
}

/**
 * Seed a read-only Base Verification Suite and Case bound to Base-Mock-e2e-Mcp.
 * Idempotent: checks for existing public suite with BASE_NAMES.verificationSuite first.
 */
export async function seedBaseVerificationSuite(adminEmail: string): Promise<void> {
  const { Client } = pg;
  const client = new Client({ connectionString: getPostgresUrl() });
  try {
    await client.connect();

    // 1. Resolve admin user ID
    const userRes = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
      [adminEmail],
    );
    if (userRes.rows.length === 0) {
      throw new Error(`Cannot seed verification suite: user ${adminEmail} not found`);
    }
    const adminId = userRes.rows[0].id;

    // 2. Resolve base MCP server ID
    const mcpRes = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM mcp_server WHERE name = $1 LIMIT 1`,
      [BASE_NAMES.mcpServer],
    );
    if (mcpRes.rows.length === 0) {
      throw new Error(
        `Cannot seed verification suite: MCP server ${BASE_NAMES.mcpServer} not found`,
      );
    }
    const mcpServerId = mcpRes.rows[0].id;
    const mcpServerName = mcpRes.rows[0].name;

    // 3. Check or insert Base Verification Suite
    let suiteId: string;
    const suiteRes = await client.query<{ id: string }>(
      `SELECT id FROM verification_suite WHERE name = $1 AND visibility = 'public' LIMIT 1`,
      [BASE_NAMES.verificationSuite],
    );

    if (suiteRes.rows.length > 0) {
      suiteId = suiteRes.rows[0].id;
    } else {
      const insertSuiteRes = await client.query<{ id: string }>(
        `INSERT INTO verification_suite (name, description, category, mcp_server_id, mcp_server_name, workflow_id, enabled, visibility, timeout_sec, created_by, updated_by)
         VALUES ($1, $2, 'mcp', $3, $4, NULL, true, 'public', 300, $5, $5)
         RETURNING id`,
        [
          BASE_NAMES.verificationSuite,
          "Base verification suite for E2E testing",
          mcpServerId,
          mcpServerName,
          adminId,
        ],
      );
      suiteId = insertSuiteRes.rows[0].id;
    }

    // 4. Check or insert Base Verification Case under the suite
    const caseRes = await client.query(
      `SELECT id FROM verification_case WHERE suite_id = $1 AND name = $2 LIMIT 1`,
      [suiteId, BASE_NAMES.verificationCase],
    );
    if (caseRes.rows.length === 0) {
      const assertionsJson = JSON.stringify([
        {
          type: "jsonpath",
          path: "$.message",
          operator: "==",
          expected: "hello",
        },
      ]);
      await client.query(
        `INSERT INTO verification_case (suite_id, created_by, name, tool_name, input, assertions, enabled)
         VALUES ($1, $2, $3, 'echo_tool', '{"message": "hello"}'::jsonb, $4::jsonb, true)`,
        [suiteId, adminId, BASE_NAMES.verificationCase, assertionsJson],
      );
    }
  } finally {
    await client.end();
  }
}

