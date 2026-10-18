import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock, loadEditableSkillMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  loadEditableSkillMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-instance", () => ({ getSession: getSessionMock }));

vi.mock("@/lib/skills/api-access", () => ({
  loadEditableSkill: loadEditableSkillMock,
}));

vi.mock("@/lib/cache/invalidation", () => ({
  invalidateForSkillChange: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

const { storageMock } = vi.hoisted(() => ({
  storageMock: {
    readFile: vi.fn(),
    listFiles: vi.fn(),
    putFile: vi.fn(),
    updateFile: vi.fn(),
    renameFolder: vi.fn(),
    deleteFile: vi.fn(),
    deleteFolder: vi.fn(),
  },
}));

vi.mock("@/lib/skills/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skills/storage")>();
  return { ...actual, getDbSkillStorage: () => storageMock };
});

import { POST } from "@/app/api/skills/[id]/files/route";
import {
  DELETE,
  PATCH,
} from "@/app/api/skills/[id]/files/[...path]/route";
import { invalidateForSkillChange } from "@/lib/cache/invalidation";
import { createMockRequest } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const me = { ...EDITOR_USER, id: "user-1" };

const rootCtx = { params: Promise.resolve({ id: "skill-1" }) };

function fileCtx(...path: string[]) {
  return { params: Promise.resolve({ id: "skill-1", path }) };
}

function skillMd(declaration: string): string {
  return `---\nname: test-skill\ndescription: A skill used by the file write route tests.\n${declaration}\n---\n\nbody\n`;
}

const SKILL = {
  id: "skill-1",
  name: "test-skill",
  visibility: "private",
  createdBy: "user-1",
  skillMd: skillMd('scripts-on-ssh: ["probe.sh"]'),
};

const SCRIPT_FILE = {
  skillId: "skill-1",
  path: "scripts/probe.sh",
  content: Buffer.from("#!/bin/sh\necho hi\n", "utf8"),
  size: 18,
  contentType: "text/x-shellscript",
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(createMockSession(me));
  loadEditableSkillMock.mockResolvedValue(SKILL);
  storageMock.readFile.mockResolvedValue(null);
  storageMock.listFiles.mockResolvedValue([]);
  storageMock.putFile.mockResolvedValue(undefined);
  storageMock.updateFile.mockResolvedValue(undefined);
  storageMock.renameFolder.mockResolvedValue(undefined);
  storageMock.deleteFile.mockResolvedValue(undefined);
  storageMock.deleteFolder.mockResolvedValue(undefined);
});

describe("POST /api/skills/[id]/files", () => {
  it("creates a root-level text file", async () => {
    const res = await POST(
      createMockRequest("/api/skills/skill-1/files", {
        method: "POST",
        body: { parentFolder: "", name: "LICENSE", content: "MIT\n" },
      }),
      rootCtx,
    );

    expect(res.status).toBe(201);
    expect(storageMock.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "LICENSE",
        contentType: "text/plain",
      }),
    );
    expect((await res.json()).path).toBe("LICENSE");
  });

  it("creates a file under a new parent folder", async () => {
    const res = await POST(
      createMockRequest("/api/skills/skill-1/files", {
        method: "POST",
        body: { parentFolder: "references", name: "guide.md" },
      }),
      rootCtx,
    );

    expect(res.status).toBe(201);
    expect(storageMock.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "references/guide.md" }),
    );
  });

  it("rejects binary file creation", async () => {
    const res = await POST(
      createMockRequest("/api/skills/skill-1/files", {
        method: "POST",
        body: { parentFolder: "assets", name: "logo.png" },
      }),
      rootCtx,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/must be imported via a \.skill archive/);
    expect(storageMock.putFile).not.toHaveBeenCalled();
  });

  it("rejects executable file creation", async () => {
    const res = await POST(
      createMockRequest("/api/skills/skill-1/files", {
        method: "POST",
        body: { parentFolder: "assets", name: "setup.exe" },
      }),
      rootCtx,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/executable file/);
    expect(storageMock.putFile).not.toHaveBeenCalled();
  });

  it("rejects executable scripts outside scripts/", async () => {
    const res = await POST(
      createMockRequest("/api/skills/skill-1/files", {
        method: "POST",
        body: { parentFolder: "lib", name: "helper.py" },
      }),
      rootCtx,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/must live under scripts\//);
  });

  it("409s when the path is already a file", async () => {
    storageMock.readFile.mockResolvedValue({
      ...SCRIPT_FILE,
      path: "LICENSE",
      content: Buffer.from("old"),
    });

    const res = await POST(
      createMockRequest("/api/skills/skill-1/files", {
        method: "POST",
        body: { parentFolder: "", name: "LICENSE" },
      }),
      rootCtx,
    );

    expect(res.status).toBe(409);
    expect(storageMock.putFile).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/skills/[id]/files/[...path]", () => {
  beforeEach(() => {
    storageMock.readFile.mockImplementation((_id: string, path: string) =>
      Promise.resolve(path === SCRIPT_FILE.path ? SCRIPT_FILE : null),
    );
  });

  it("renames a declared script and syncs scripts-on-ssh", async () => {
    const res = await PATCH(
      createMockRequest(
        "/api/skills/skill-1/files/scripts/probe.sh?kind=file",
        { method: "PATCH", body: { name: "renamed.sh" } },
      ),
      fileCtx("scripts", "probe.sh"),
    );

    expect(res.status).toBe(200);
    expect(storageMock.updateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        oldPath: "scripts/probe.sh",
        newPath: "scripts/renamed.sh",
        skillMd: expect.stringContaining('scripts-on-ssh: ["scripts/renamed.sh"]'),
      }),
    );
    expect(invalidateForSkillChange).toHaveBeenCalledWith("skill-1");
  });

  it("rewrites text content without changing the path", async () => {
    const res = await PATCH(
      createMockRequest(
        "/api/skills/skill-1/files/scripts/probe.sh?kind=file",
        { method: "PATCH", body: { content: "echo updated\n" } },
      ),
      fileCtx("scripts", "probe.sh"),
    );

    expect(res.status).toBe(200);
    expect(storageMock.updateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        oldPath: "scripts/probe.sh",
        newPath: "scripts/probe.sh",
        content: Buffer.from("echo updated\n", "utf8"),
      }),
    );
  });

  it("allows text editing of a .py reference file outside scripts/", async () => {
    const referenceFile = {
      ...SCRIPT_FILE,
      path: "lib/helper.py",
      contentType: "text/x-python",
    };
    storageMock.readFile.mockImplementation((_id: string, path: string) =>
      Promise.resolve(path === "lib/helper.py" ? referenceFile : null),
    );

    const res = await PATCH(
      createMockRequest(
        "/api/skills/skill-1/files/lib/helper.py?kind=file",
        { method: "PATCH", body: { content: "print('updated')\n" } },
      ),
      fileCtx("lib", "helper.py"),
    );

    expect(res.status).toBe(200);
    expect(storageMock.updateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        oldPath: "lib/helper.py",
        newPath: "lib/helper.py",
        content: Buffer.from("print('updated')\n", "utf8"),
      }),
    );
  });

  it("rejects renaming a text file to an executable type", async () => {
    const res = await PATCH(
      createMockRequest(
        "/api/skills/skill-1/files/scripts/probe.sh?kind=file",
        { method: "PATCH", body: { name: "probe.exe" } },
      ),
      fileCtx("scripts", "probe.sh"),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/executable file/);
    expect(storageMock.updateFile).not.toHaveBeenCalled();
  });

  it("rejects renaming text content to an image type", async () => {
    const res = await PATCH(
      createMockRequest(
        "/api/skills/skill-1/files/scripts/probe.sh?kind=file",
        { method: "PATCH", body: { name: "probe.png" } },
      ),
      fileCtx("scripts", "probe.sh"),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(
      /Cannot rename text content to an image/,
    );
    expect(storageMock.updateFile).not.toHaveBeenCalled();
  });

  it("renames a declared SQL file and syncs scripts-on-db", async () => {
    const sqlFile = {
      skillId: "skill-1",
      path: "scripts/reports/sales.sql",
      content: Buffer.from("SELECT 1;\n"),
      size: 10,
      contentType: "text/plain",
    };
    loadEditableSkillMock.mockResolvedValue({
      ...SKILL,
      skillMd: skillMd('scripts-on-db: ["reports/sales.sql"]'),
    });
    storageMock.readFile.mockImplementation((_id: string, path: string) =>
      Promise.resolve(path === sqlFile.path ? sqlFile : null),
    );

    const res = await PATCH(
      createMockRequest(
        "/api/skills/skill-1/files/scripts/reports/sales.sql?kind=file",
        { method: "PATCH", body: { name: "monthly.sql" } },
      ),
      fileCtx("scripts", "reports", "sales.sql"),
    );

    expect(res.status).toBe(200);
    expect(storageMock.updateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        oldPath: "scripts/reports/sales.sql",
        newPath: "scripts/reports/monthly.sql",
        skillMd: expect.stringContaining(
          'scripts-on-db: ["scripts/reports/monthly.sql"]',
        ),
      }),
    );
    expect(invalidateForSkillChange).toHaveBeenCalledWith("skill-1");
  });

  it("removes a scripts-on-db declaration when renamed to non-.sql", async () => {
    const sqlFile = {
      skillId: "skill-1",
      path: "scripts/reports/sales.sql",
      content: Buffer.from("SELECT 1;\n"),
      size: 10,
      contentType: "text/plain",
    };
    loadEditableSkillMock.mockResolvedValue({
      ...SKILL,
      skillMd: skillMd('scripts-on-db: ["reports/sales.sql"]'),
    });
    storageMock.readFile.mockImplementation((_id: string, path: string) =>
      Promise.resolve(path === sqlFile.path ? sqlFile : null),
    );

    const res = await PATCH(
      createMockRequest(
        "/api/skills/skill-1/files/scripts/reports/sales.sql?kind=file",
        { method: "PATCH", body: { name: "sales.txt" } },
      ),
      fileCtx("scripts", "reports", "sales.sql"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toMatch(/no longer a \.sql file/);
    expect(storageMock.updateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        skillMd: expect.not.stringContaining("scripts-on-db"),
      }),
    );
  });

  it("renames an implicit folder", async () => {
    storageMock.listFiles.mockResolvedValue([
      { path: "assets/logo.png" },
      { path: "assets/nested/icon.png" },
    ]);

    const res = await PATCH(
      createMockRequest("/api/skills/skill-1/files/assets?kind=folder", {
        method: "PATCH",
        body: { name: "images" },
      }),
      fileCtx("assets"),
    );

    expect(res.status).toBe(200);
    expect(storageMock.renameFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        oldPath: "assets",
        newPath: "images",
      }),
    );
    expect((await res.json()).files).toBe(2);
  });

  it("renames a folder under scripts/ and syncs declarations", async () => {
    loadEditableSkillMock.mockResolvedValue({
      ...SKILL,
      skillMd: skillMd('scripts-on-ssh: ["lib/probe.sh"]'),
    });
    storageMock.listFiles.mockResolvedValue([
      { path: "scripts/lib/probe.sh" },
    ]);

    const res = await PATCH(
      createMockRequest(
        "/api/skills/skill-1/files/scripts/lib?kind=folder",
        { method: "PATCH", body: { name: "util" } },
      ),
      fileCtx("scripts", "lib"),
    );

    expect(res.status).toBe(200);
    expect(storageMock.renameFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        oldPath: "scripts/lib",
        newPath: "scripts/util",
        skillMd: expect.stringContaining(
          'scripts-on-ssh: ["scripts/util/probe.sh"]',
        ),
      }),
    );
    expect(invalidateForSkillChange).toHaveBeenCalledWith("skill-1");
  });

  it("refuses to rename the top-level scripts/ folder", async () => {
    storageMock.listFiles.mockResolvedValue([
      { path: "scripts/probe.sh" },
    ]);

    const res = await PATCH(
      createMockRequest("/api/skills/skill-1/files/scripts?kind=folder", {
        method: "PATCH",
        body: { name: "bin" },
      }),
      fileCtx("scripts"),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/reserved/);
    expect(storageMock.renameFolder).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/skills/[id]/files/[...path]", () => {
  it("deletes a declared script and removes its declaration", async () => {
    storageMock.readFile.mockResolvedValue(SCRIPT_FILE);

    const res = await DELETE(
      createMockRequest(
        "/api/skills/skill-1/files/scripts/probe.sh?kind=file",
        { method: "DELETE" },
      ),
      fileCtx("scripts", "probe.sh"),
    );

    expect(res.status).toBe(204);
    expect(storageMock.deleteFile).toHaveBeenCalledWith(
      "skill-1",
      "scripts/probe.sh",
      expect.objectContaining({
        skillMd: expect.not.stringContaining("scripts-on-ssh"),
      }),
    );
    expect(invalidateForSkillChange).toHaveBeenCalledWith("skill-1");
  });

  it("deletes the scripts/ folder and removes all declarations", async () => {
    storageMock.listFiles.mockResolvedValue([
      { path: "scripts/probe.sh" },
      { path: "scripts/other.py" },
    ]);

    const res = await DELETE(
      createMockRequest("/api/skills/skill-1/files/scripts?kind=folder", {
        method: "DELETE",
      }),
      fileCtx("scripts"),
    );

    expect(res.status).toBe(204);
    expect(storageMock.deleteFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "scripts",
        skillMd: expect.not.stringContaining("scripts-on-ssh"),
      }),
    );
  });

  it("deletes a sub-folder under scripts/ and removes its declarations", async () => {
    loadEditableSkillMock.mockResolvedValue({
      ...SKILL,
      skillMd: skillMd('scripts-on-ssh: ["lib/probe.sh"]'),
    });
    storageMock.listFiles.mockResolvedValue([
      { path: "scripts/lib/probe.sh" },
    ]);

    const res = await DELETE(
      createMockRequest("/api/skills/skill-1/files/scripts/lib?kind=folder", {
        method: "DELETE",
      }),
      fileCtx("scripts", "lib"),
    );

    expect(res.status).toBe(204);
    expect(storageMock.deleteFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "scripts/lib",
        skillMd: expect.not.stringContaining("scripts-on-ssh"),
      }),
    );
    expect(invalidateForSkillChange).toHaveBeenCalledWith("skill-1");
  });

  it("deletes a declared SQL file and removes its scripts-on-db entry", async () => {
    const sqlFile = {
      skillId: "skill-1",
      path: "scripts/reports/sales.sql",
      content: Buffer.from("SELECT 1;\n"),
      size: 10,
      contentType: "text/plain",
    };
    loadEditableSkillMock.mockResolvedValue({
      ...SKILL,
      skillMd: skillMd('scripts-on-db: ["reports/sales.sql"]'),
    });
    storageMock.readFile.mockResolvedValue(sqlFile);

    const res = await DELETE(
      createMockRequest(
        "/api/skills/skill-1/files/scripts/reports/sales.sql?kind=file",
        { method: "DELETE" },
      ),
      fileCtx("scripts", "reports", "sales.sql"),
    );

    expect(res.status).toBe(204);
    expect(storageMock.deleteFile).toHaveBeenCalledWith(
      "skill-1",
      "scripts/reports/sales.sql",
      expect.objectContaining({
        skillMd: expect.not.stringContaining("scripts-on-db"),
      }),
    );
  });

  it("deletes a folder and all descendants", async () => {
    storageMock.listFiles.mockResolvedValue([
      { path: "references/a.md" },
      { path: "references/b.md" },
      { path: "scripts/probe.sh" },
    ]);

    const res = await DELETE(
      createMockRequest("/api/skills/skill-1/files/references?kind=folder", {
        method: "DELETE",
      }),
      fileCtx("references"),
    );

    expect(res.status).toBe(204);
    expect(storageMock.deleteFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "references",
        skillMd: undefined,
      }),
    );
  });
});
