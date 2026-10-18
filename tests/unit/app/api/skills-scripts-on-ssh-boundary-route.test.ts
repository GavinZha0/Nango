import { describe, it, expect, vi, beforeEach } from "vitest";

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
    listFiles: vi.fn(),
    createCustom: vi.fn(),
    updateContent: vi.fn(),
    updateFlags: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/skills/storage", () => ({
  getDbSkillStorage: () => storageMock,
}));

import { POST } from "@/app/api/skills/route";
import { DELETE, GET, PATCH } from "@/app/api/skills/[id]/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;
const me = { ...EDITOR_USER, id: "user-1" };

const rootCtx = { params: Promise.resolve({}) };
const idCtx = { params: Promise.resolve({ id: "skill-1" }) };

function skillMd(sshDecl: string | null): string {
  const lines = [
    "name: test-skill",
    "description: A skill used by the write-boundary tests.",
  ];
  if (sshDecl) lines.push(sshDecl);
  return `---\n${lines.join("\n")}\n---\n\nbody\n`;
}

const LOCAL_ROW = {
  id: "skill-1",
  name: "test-skill",
  visibility: "private",
  createdBy: "user-1",
  skillMd: skillMd('scripts-on-ssh: ["probe.sh"]'),
};

describe("skills routes — scripts-on-ssh write boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(me));
    storageMock.listFiles.mockResolvedValue([]);
    storageMock.createCustom.mockResolvedValue({ id: "skill-1" });
  });

  describe("POST /api/skills", () => {
    // A created row owns no skill_file and the file route is read-only, so a
    // declaration made here can never be satisfied.
    it("rejects a declaration instead of creating an unsatisfiable skill", async () => {
      dbMock.$enqueue([]);

      const req = createMockRequest("/api/skills", {
        method: "POST",
        body: { skillMd: skillMd('scripts-on-ssh: ["probe.sh"]') },
      });
      const res = await POST(req, rootCtx);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toMatch(/declares missing file\(s\): scripts\/probe\.sh/);
      expect(json.message).toMatch(/POST \/api\/skills\/import/);
      expect(storageMock.createCustom).not.toHaveBeenCalled();
    });

    it("creates a skill with no declaration", async () => {
      dbMock.$enqueue([], [LOCAL_ROW]);

      const req = createMockRequest("/api/skills", {
        method: "POST",
        body: { skillMd: skillMd(null) },
      });
      const res = await POST(req, rootCtx);

      expect(res.status).toBe(201);
      expect(storageMock.createCustom).toHaveBeenCalledTimes(1);
    });
  });

  describe("PATCH /api/skills/[id]", () => {
    it("rejects a declaration whose file is not stored", async () => {
      dbMock.$enqueue([LOCAL_ROW]);
      storageMock.listFiles.mockResolvedValue([{ path: "scripts/other.sh" }]);

      const req = createMockRequest("/api/skills/skill-1", {
        method: "PATCH",
        body: { skillMd: skillMd('scripts-on-ssh: ["probe.sh"]') },
      });
      const res = await PATCH(req, idCtx);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toMatch(/declares missing file\(s\): scripts\/probe\.sh/);
      expect(json.message).toMatch(/scripts\/: scripts\/other\.sh/);
      expect(storageMock.updateContent).not.toHaveBeenCalled();
    });

    it("accepts a declaration backed by a stored file", async () => {
      dbMock.$enqueue([LOCAL_ROW], [LOCAL_ROW]);
      storageMock.listFiles.mockResolvedValue([{ path: "scripts/probe.sh" }]);

      const req = createMockRequest("/api/skills/skill-1", {
        method: "PATCH",
        body: { skillMd: skillMd('scripts-on-ssh: ["probe.sh"]') },
      });
      const res = await PATCH(req, idCtx);

      expect(res.status).toBe(200);
      expect(storageMock.updateContent).toHaveBeenCalledTimes(1);
    });

    it("skips the file listing when nothing is declared", async () => {
      dbMock.$enqueue([LOCAL_ROW], [LOCAL_ROW]);

      const req = createMockRequest("/api/skills/skill-1", {
        method: "PATCH",
        body: { skillMd: skillMd(null) },
      });
      const res = await PATCH(req, idCtx);

      expect(res.status).toBe(200);
      expect(storageMock.listFiles).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/skills/[id]", () => {
    it("reports unbacked declarations so the editor can warn", async () => {
      dbMock.$enqueue([LOCAL_ROW]);
      storageMock.listFiles.mockResolvedValue([{ path: "scripts/other.sh" }]);

      const res = await GET(createMockRequest("/api/skills/skill-1"), idCtx);

      expect(res.status).toBe(200);
      expect((await res.json()).missingSshScripts).toEqual(["scripts/probe.sh"]);
    });

    it("reports nothing when the declaration is satisfied", async () => {
      dbMock.$enqueue([LOCAL_ROW]);
      storageMock.listFiles.mockResolvedValue([{ path: "scripts/probe.sh" }]);

      const res = await GET(createMockRequest("/api/skills/skill-1"), idCtx);

      expect((await res.json()).missingSshScripts).toEqual([]);
    });

    it("survives a stored body that no longer parses", async () => {
      dbMock.$enqueue([{ ...LOCAL_ROW, skillMd: "no frontmatter at all" }]);
      storageMock.listFiles.mockResolvedValue([{ path: "scripts/probe.sh" }]);

      const res = await GET(createMockRequest("/api/skills/skill-1"), idCtx);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.missingSshScripts).toEqual([]);
      // The listing still ships: the file tree does not depend on the body
      // parsing, only the scripts-on-ssh diagnostic does.
      expect(json.files).toEqual([{ path: "scripts/probe.sh" }]);
    });

    it("returns the file listing sorted by path", async () => {
      dbMock.$enqueue([{ ...LOCAL_ROW, skillMd: skillMd(null) }]);
      storageMock.listFiles.mockResolvedValue([
        { path: "scripts/zebra.py", size: 30, contentType: "text/x-python" },
        { path: "references/output.md", size: 10, contentType: "text/markdown" },
        { path: "scripts/alpha.sh", size: 20, contentType: "text/x-shellscript" },
      ]);

      const res = await GET(createMockRequest("/api/skills/skill-1"), idCtx);

      const { files, scriptsOnSsh } = await res.json();
      expect(files.map((f: { path: string }) => f.path)).toEqual([
        "references/output.md",
        "scripts/alpha.sh",
        "scripts/zebra.py",
      ]);
      expect(scriptsOnSsh).toEqual([]);
    });

    it("returns an empty listing for a skill with no helper files", async () => {
      dbMock.$enqueue([{ ...LOCAL_ROW, skillMd: skillMd(null) }]);

      const res = await GET(createMockRequest("/api/skills/skill-1"), idCtx);

      const json = await res.json();
      expect(json.files).toEqual([]);
      expect(json.missingSshScripts).toEqual([]);
    });

    it("echoes the declared scripts so the tree can flag them", async () => {
      dbMock.$enqueue([LOCAL_ROW]);
      storageMock.listFiles.mockResolvedValue([{ path: "scripts/probe.sh" }]);

      const res = await GET(createMockRequest("/api/skills/skill-1"), idCtx);

      expect((await res.json()).scriptsOnSsh).toEqual(["scripts/probe.sh"]);
    });
  });

  it("DELETE still removes the row", async () => {
    dbMock.$enqueue([LOCAL_ROW]);

    const res = await DELETE(
      createMockRequest("/api/skills/skill-1", { method: "DELETE" }),
      idCtx,
    );

    expect(res.status).toBe(204);
    expect(storageMock.delete).toHaveBeenCalledWith("skill-1");
  });
});
