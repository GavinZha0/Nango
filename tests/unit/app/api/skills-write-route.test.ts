import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("@/lib/auth/auth-instance", () => ({ getSession: getSessionMock }));

vi.mock("@/lib/cache/invalidation", () => ({
  invalidateForSkillChange: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

const { storageMock } = vi.hoisted(() => ({
  storageMock: {
    createCustom: vi.fn(),
    updateContent: vi.fn(),
    updateFlags: vi.fn(),
    listFiles: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/skills/storage", () => ({
  getDbSkillStorage: () => storageMock,
}));

import { POST } from "@/app/api/skills/route";
import { PATCH } from "@/app/api/skills/[id]/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;
const me = { ...EDITOR_USER, id: "user-1" };

const rootCtx = { params: Promise.resolve({}) };
const idCtx = { params: Promise.resolve({ id: "skill-1" }) };

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: A skill used by the write-route tests.\n---\n\nbody\n`;
}

const ROW = {
  id: "skill-1",
  name: "test-skill",
  description: "A skill used by the write-route tests.",
  version: "1.0.0",
  source: "",
  enabled: true,
  visibility: "private",
  createdBy: "user-1",
  skillMd: skillMd("test-skill"),
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$reset();
  getSessionMock.mockResolvedValue(createMockSession(me));
  storageMock.createCustom.mockResolvedValue({ id: "skill-1" });
  storageMock.listFiles.mockResolvedValue([]);
});

describe("POST /api/skills", () => {
  it("passes the free-form source label through on create", async () => {
    dbMock.$enqueue([], [ROW]);

    const res = await POST(
      createMockRequest("/api/skills", {
        method: "POST",
        body: { skillMd: skillMd("test-skill"), source: "anthropic" },
      }),
      rootCtx,
    );

    expect(res.status).toBe(201);
    expect(storageMock.createCustom).toHaveBeenCalledWith(
      expect.objectContaining({ source: "anthropic" }),
    );
  });
});

describe("PATCH /api/skills/[id]", () => {
  it("persists a source-only update alongside the existing SKILL.md", async () => {
    dbMock.$enqueue([ROW], [{ ...ROW, source: "skills.sh" }]);

    const res = await PATCH(
      createMockRequest("/api/skills/skill-1", {
        method: "PATCH",
        body: { source: "skills.sh" },
      }),
      idCtx,
    );

    expect(res.status).toBe(200);
    expect(storageMock.updateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "skill-1",
        skillMd: ROW.skillMd,
        source: "skills.sh",
        updatedBy: "user-1",
      }),
    );
    expect(storageMock.updateFlags).not.toHaveBeenCalled();
  });

  it("renames the skill when the frontmatter name changes", async () => {
    const renamedMd = skillMd("renamed-skill");
    dbMock.$enqueue(
      [ROW],
      [],
      [{ ...ROW, name: "renamed-skill", skillMd: renamedMd }],
    );

    const res = await PATCH(
      createMockRequest("/api/skills/skill-1", {
        method: "PATCH",
        body: { skillMd: renamedMd },
      }),
      idCtx,
    );

    expect(res.status).toBe(200);
    expect(storageMock.updateContent).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "skill-1", skillMd: renamedMd }),
    );
  });

  it("returns 409 when the rename collides with another skill owned by the creator", async () => {
    const renamedMd = skillMd("taken-name");
    dbMock.$enqueue([ROW], [{ id: "skill-2" }]);

    const res = await PATCH(
      createMockRequest("/api/skills/skill-1", {
        method: "PATCH",
        body: { skillMd: renamedMd },
      }),
      idCtx,
    );

    expect(res.status).toBe(409);
    expect(storageMock.updateContent).not.toHaveBeenCalled();
  });
});
