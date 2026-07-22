import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// db is queried in a deterministic order per call: isAdminUser (UserTable)
// → [workflow visibility | parent-run owner]. A FIFO queue returns the
// next result for each `.limit()`. isAgentVisibleTo / credential lookups
// are mocked separately and do NOT consume the queue.
let dbQueue: unknown[][] = [];
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(dbQueue.shift() ?? []),
        }),
      }),
    }),
  },
}));

const mockAgentVisible = vi.fn();
vi.mock("@/lib/access/agent-visibility", () => ({
  isAgentVisibleTo: (id: string, uid: string) => mockAgentVisible(id, uid),
}));

const mockCred = vi.fn();
vi.mock("@/lib/credentials/lookup", () => ({
  getAgentCredentialConfigById: (id: string) => mockCred(id),
}));

import { admitRun, RunAdmissionError } from "@/lib/runner/admission";
import type { AdmissionInput } from "@/lib/runner/admission";

function base(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    ownerId: "owner-1",
    entityId: "agent-1",
    entityKind: "agent",
    entitySource: "builtin",
    initiator: "user",
    ...overrides,
  };
}

/** Non-admin user row for isAdminUser. */
const NON_ADMIN: unknown[] = [{ role: "user" }];
const ADMIN: unknown[] = [{ role: "admin" }];

beforeEach(() => {
  dbQueue = [];
  mockAgentVisible.mockReset();
  mockCred.mockReset();
});

describe("admitRun — built-in agent visibility", () => {
  it("passes when the agent is visible to the owner", async () => {
    dbQueue = [NON_ADMIN];
    mockAgentVisible.mockResolvedValue(true);
    await expect(admitRun(base())).resolves.toBeUndefined();
  });

  it("rejects when the agent is not visible", async () => {
    dbQueue = [NON_ADMIN];
    mockAgentVisible.mockResolvedValue(false);
    await expect(admitRun(base())).rejects.toBeInstanceOf(RunAdmissionError);
  });

  it("admin bypasses visibility", async () => {
    dbQueue = [ADMIN];
    mockAgentVisible.mockResolvedValue(false);
    await expect(admitRun(base())).resolves.toBeUndefined();
  });
});

describe("admitRun — system-initiated exemption", () => {
  it("skips entity visibility for the evaluator initiator", async () => {
    dbQueue = [NON_ADMIN];
    mockAgentVisible.mockResolvedValue(false); // would fail if checked
    await expect(admitRun(base({ initiator: "evaluator" }))).resolves.toBeUndefined();
    expect(mockAgentVisible).not.toHaveBeenCalled();
  });
});

describe("admitRun — workflow visibility", () => {
  it("passes for an owned workflow", async () => {
    dbQueue = [NON_ADMIN, [{ visibility: "private", createdBy: "owner-1" }]];
    await expect(
      admitRun(base({ entityKind: "workflow", entityId: "wf-1" })),
    ).resolves.toBeUndefined();
  });

  it("passes for a public workflow owned by someone else", async () => {
    dbQueue = [NON_ADMIN, [{ visibility: "public", createdBy: "other" }]];
    await expect(
      admitRun(base({ entityKind: "workflow", entityId: "wf-1" })),
    ).resolves.toBeUndefined();
  });

  it("rejects another owner's private workflow", async () => {
    dbQueue = [NON_ADMIN, [{ visibility: "private", createdBy: "other" }]];
    await expect(
      admitRun(base({ entityKind: "workflow", entityId: "wf-1" })),
    ).rejects.toBeInstanceOf(RunAdmissionError);
  });
});

describe("admitRun — parent-run ownership", () => {
  it("passes when the parent run has the same owner", async () => {
    dbQueue = [NON_ADMIN, [{ ownerId: "owner-1" }]];
    mockAgentVisible.mockResolvedValue(true);
    await expect(admitRun(base({ parentRunId: "run-parent" }))).resolves.toBeUndefined();
  });

  it("rejects when the parent run belongs to another owner", async () => {
    dbQueue = [NON_ADMIN, [{ ownerId: "other" }]];
    mockAgentVisible.mockResolvedValue(true);
    await expect(
      admitRun(base({ parentRunId: "run-parent" })),
    ).rejects.toBeInstanceOf(RunAdmissionError);
  });

  it("rejects when the parent run does not exist", async () => {
    dbQueue = [NON_ADMIN, []];
    mockAgentVisible.mockResolvedValue(true);
    await expect(
      admitRun(base({ parentRunId: "ghost" })),
    ).rejects.toBeInstanceOf(RunAdmissionError);
  });
});

describe("admitRun — credential", () => {
  it("rejects a missing/disabled credential", async () => {
    dbQueue = [NON_ADMIN];
    mockAgentVisible.mockResolvedValue(true);
    mockCred.mockResolvedValue(null);
    await expect(
      admitRun(base({ credentialId: "cred-1" })),
    ).rejects.toBeInstanceOf(RunAdmissionError);
  });

  it("passes an enabled agent credential", async () => {
    dbQueue = [NON_ADMIN];
    mockAgentVisible.mockResolvedValue(true);
    mockCred.mockResolvedValue({ provider: "openai" });
    await expect(
      admitRun(base({ credentialId: "cred-1" })),
    ).resolves.toBeUndefined();
  });
});
