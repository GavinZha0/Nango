import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("@/lib/auth/auth-instance", () => ({ getSession: getSessionMock }));

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

const { storageMock, InvalidSkillPathError } = vi.hoisted(() => {
  class InvalidSkillPathError extends Error {}
  return {
    storageMock: { readFile: vi.fn(), listFiles: vi.fn() },
    InvalidSkillPathError,
  };
});

vi.mock("@/lib/skills/storage", () => ({
  getDbSkillStorage: () => storageMock,
  InvalidSkillPathError,
}));

import { GET } from "@/app/api/skills/[id]/files/[...path]/route";
import { db } from "@/lib/db";
import { createMockRequest, type MockDrizzleDb } from "tests/unit/helpers";
import {
  ADMIN_USER,
  EDITOR_USER,
  createMockSession,
} from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;
const owner = { ...EDITOR_USER, id: "user-1" };
const stranger = { ...EDITOR_USER, id: "user-2" };
const admin = { ...ADMIN_USER, id: "user-admin-1" };

const PRIVATE_ROW = {
  id: "skill-1",
  source: "local",
  visibility: "private",
  createdBy: "user-1",
};
const PUBLIC_ROW = { ...PRIVATE_ROW, visibility: "public" };

const FILE = {
  skillId: "skill-1",
  path: "references/output.md",
  content: Buffer.from("# Output\n", "utf8"),
  size: 9,
  contentType: "text/markdown",
};

function ctx(path: string[]) {
  return { params: Promise.resolve({ id: "skill-1", path }) };
}

const req = () => createMockRequest("/api/skills/skill-1/files/references/output.md");

describe("GET /api/skills/[id]/files/[...path]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    storageMock.readFile.mockResolvedValue(FILE);
  });

  it("serves the owner their private skill's file", async () => {
    getSessionMock.mockResolvedValue(createMockSession(owner));
    dbMock.$enqueue([PRIVATE_ROW]);

    const res = await GET(req(), ctx(["references", "output.md"]));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      path: "references/output.md",
      encoding: "utf8",
      content: "# Output\n",
      size: 9,
    });
  });

  // Regression: the route used to hand-roll `public || mine`, which omits the
  // admin exception in canViewResource. An admin could list a private skill's
  // files via the detail route and then 404 on every one of them.
  it("serves an admin someone else's private file", async () => {
    getSessionMock.mockResolvedValue(createMockSession(admin));
    dbMock.$enqueue([PRIVATE_ROW]);

    const res = await GET(req(), ctx(["references", "output.md"]));

    expect(res.status).toBe(200);
    expect(storageMock.readFile).toHaveBeenCalledWith(
      "skill-1",
      "references/output.md",
    );
  });

  it("hides a private file from a non-owner editor", async () => {
    getSessionMock.mockResolvedValue(createMockSession(stranger));
    dbMock.$enqueue([PRIVATE_ROW]);

    const res = await GET(req(), ctx(["references", "output.md"]));

    expect(res.status).toBe(404);
    expect(storageMock.readFile).not.toHaveBeenCalled();
  });

  it("serves a public file to any session", async () => {
    getSessionMock.mockResolvedValue(createMockSession(stranger));
    dbMock.$enqueue([PUBLIC_ROW]);

    const res = await GET(req(), ctx(["references", "output.md"]));

    expect(res.status).toBe(200);
  });

  it("404s on an unknown skill", async () => {
    getSessionMock.mockResolvedValue(createMockSession(owner));
    dbMock.$enqueue([]);

    const res = await GET(req(), ctx(["references", "output.md"]));

    expect(res.status).toBe(404);
  });

  it("404s when the skill exists but the path does not", async () => {
    getSessionMock.mockResolvedValue(createMockSession(owner));
    dbMock.$enqueue([PRIVATE_ROW]);
    storageMock.readFile.mockResolvedValue(null);

    const res = await GET(req(), ctx(["references", "nope.md"]));

    expect(res.status).toBe(404);
  });

  it("resolves a bare filename against the skill's own listing", async () => {
    getSessionMock.mockResolvedValue(createMockSession(owner));
    dbMock.$enqueue([PRIVATE_ROW]);
    storageMock.listFiles.mockResolvedValue([
      { path: "references/other.md" },
      { path: "lib/output.md" },
      { path: "rules/output.md" },
    ]);

    const res = await GET(req(), ctx(["output.md"]));

    expect(res.status).toBe(200);
    // Sorted candidates, so `lib/` wins deterministically over `rules/`.
    expect(storageMock.readFile).toHaveBeenCalledWith("skill-1", "lib/output.md");
  });

  it("404s when a bare filename matches nothing in the listing", async () => {
    getSessionMock.mockResolvedValue(createMockSession(owner));
    dbMock.$enqueue([PRIVATE_ROW]);
    storageMock.listFiles.mockResolvedValue([{ path: "references/other.md" }]);

    const res = await GET(req(), ctx(["output.md"]));

    expect(res.status).toBe(404);
    expect(storageMock.readFile).not.toHaveBeenCalled();
  });

  it("400s on an empty path", async () => {
    getSessionMock.mockResolvedValue(createMockSession(owner));
    dbMock.$enqueue([PRIVATE_ROW]);

    const res = await GET(req(), ctx([]));

    expect(res.status).toBe(400);
  });

  it("base64-encodes content that looks binary", async () => {
    getSessionMock.mockResolvedValue(createMockSession(owner));
    dbMock.$enqueue([PRIVATE_ROW]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    storageMock.readFile.mockResolvedValue({
      ...FILE,
      path: "assets/logo.png",
      content: png,
      size: png.length,
      contentType: "image/png",
    });

    const res = await GET(req(), ctx(["assets", "logo.png"]));

    const json = await res.json();
    expect(json.encoding).toBe("base64");
    expect(json.content).toBe(png.toString("base64"));
  });
});
