import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";
import { BASE_NAMES, E2E_PLACEHOLDER_KEY } from "../constants/base-resources";

/**
 * Seed Layer 0 (LLM Credential) and Layer 1 (Supervisor, General, Evaluator Agents)
 * into the database via the authenticated Admin API context.
 *
 * Idempotent: 409 Conflict (e.g. supervisor or credential already exists) is safely tolerated.
 * CONTRACT: All base agents are created with visibility: "public" so they are visible to all roles.
 */
export async function seedBaseResources(request: APIRequestContext): Promise<void> {
  // 1. Base LLM Credential
  const credRes = await request.post("/api/admin/credentials", {
    data: {
      name: BASE_NAMES.llmCredential,
      type: "api_key",
      serviceType: "llm",
      provider: "openai",
      payload: { key: E2E_PLACEHOLDER_KEY },
    },
  });

  let credId: string;
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

  // Helper for agent seeding with visibility: "public" & 409 tolerance
  async function seedAgent(data: {
    name: string;
    role: "supervisor" | "evaluator" | null;
    model: string;
    modelProvider: string;
    credentialId: string;
    enabled: boolean;
    visibility: "public";
  }) {
    const res = await request.post("/api/builtin-agents", { data });
    if (res.status() === 409) {
      // Role uniqueness conflict (e.g. supervisor already exists) — safe to proceed
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
      enabled: true,
    },
  });
  expect(createRes.ok(), await createRes.text()).toBeTruthy();
}
