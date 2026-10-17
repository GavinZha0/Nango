import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import type { NextRequest } from "next/server";

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
    putFile: vi.fn(),
  },
}));

vi.mock("@/lib/skills/storage", () => ({
  getDbSkillStorage: () => storageMock,
}));

import { POST } from "@/app/api/skills/import/route";
import { db } from "@/lib/db";
import { type MockDrizzleDb } from "tests/unit/helpers";
import { EDITOR_USER, createMockSession } from "tests/unit/fixtures";

const dbMock = db as unknown as MockDrizzleDb;
const me = { ...EDITOR_USER, id: "user-1" };
const ctx = { params: Promise.resolve({}) };

const SKILL_MD = (decl: string | null): string =>
  `---\nname: probe-skill\ndescription: A skill used by the import boundary tests.\n${
    decl ?? ""
  }\n---\n\nbody\n`;

async function upload(
  entries: Array<{ path: string; content: string | Buffer }>,
  decl: string | null = 'scripts-on-ssh: ["probe.sh"]',
): Promise<Response> {
  const zip = new JSZip();
  zip.file("SKILL.md", SKILL_MD(decl));
  for (const e of entries) zip.file(e.path, e.content);
  const blob = await zip.generateAsync({ type: "nodebuffer" });

  const form = new FormData();
  form.set("file", new File([new Uint8Array(blob)], "probe.skill"));
  const req = new Request("http://localhost/api/skills/import", {
    method: "POST",
    body: form,
  }) as unknown as NextRequest;
  return POST(req, ctx);
}

describe("POST /api/skills/import — scripts-on-ssh boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$reset();
    getSessionMock.mockResolvedValue(createMockSession(me));
    storageMock.createCustom.mockResolvedValue({ id: "skill-1" });
  });

  it("rejects a declaration with no matching file, before writing anything", async () => {
    dbMock.$enqueue([]);

    const res = await upload([{ path: "scripts/other.sh", content: "echo hi\n" }]);

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/declares missing file\(s\): scripts\/probe\.sh/);
    expect(storageMock.createCustom).not.toHaveBeenCalled();
    expect(storageMock.putFile).not.toHaveBeenCalled();
  });

  it("rejects a declared script that is not valid UTF-8", async () => {
    dbMock.$enqueue([]);

    const res = await upload([
      { path: "scripts/probe.sh", content: Buffer.from([0x23, 0x20, 0xc4, 0xe3, 0x0a]) },
    ]);

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/scripts\/probe\.sh is not valid UTF-8/);
    expect(storageMock.createCustom).not.toHaveBeenCalled();
  });

  it("rejects a declared script containing NUL bytes", async () => {
    dbMock.$enqueue([]);

    const res = await upload([
      { path: "scripts/probe.sh", content: Buffer.from("echo \0 hi\n", "utf-8") },
    ]);

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/contains NUL bytes/);
  });

  it("imports a skill whose declared script is clean UTF-8", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", source: "local", createdBy: "user-1" },
    ]);

    const res = await upload([
      { path: "scripts/probe.sh", content: 'echo "héllo"\n' },
    ]);

    expect(res.status).toBe(201);
    expect(storageMock.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "scripts/probe.sh" }),
    );
  });

  it("leaves undeclared scripts alone", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", source: "local", createdBy: "user-1" },
    ]);

    const res = await upload(
      [{ path: "scripts/probe.sh", content: Buffer.from([0xc4, 0xe3, 0x0a]) }],
      null,
    );

    expect(res.status).toBe(201);
  });
});
