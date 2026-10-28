import { describe, it, expect, vi, beforeEach } from "vitest";
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
  skillMd?: string,
): Promise<Response> {
  const payload = {
    entries: [
      {
        path: "SKILL.md",
        contentBase64: Buffer.from(skillMd ?? SKILL_MD(decl)).toString("base64"),
      },
      ...entries.map((e) => ({
        path: e.path,
        contentBase64: Buffer.from(e.content).toString("base64"),
      })),
    ],
  };
  const req = new Request("http://localhost/api/skills/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
    expect((await res.json()).message).toMatch(/NUL bytes/);
  });

  it("imports a skill whose declared script is clean UTF-8", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", createdBy: "user-1" },
    ]);

    const res = await upload([
      { path: "scripts/probe.sh", content: 'echo "héllo"\n' },
    ]);

    expect(res.status).toBe(201);
    expect(storageMock.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "scripts/probe.sh" }),
    );
  });

  it("persists an image content type for the editor preview", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", createdBy: "user-1" },
    ]);

    // 1x1 transparent PNG — real binary bytes, so it takes the base64 branch.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const res = await upload(
      [
        { path: "assets/logo.png", content: png },
        { path: "references/guide.md", content: "# Guide\n" },
      ],
      null,
    );

    expect(res.status).toBe(201);
    // The editor keys its image preview off this column; when it was left null
    // every binary file degraded to a card that could not be previewed.
    expect(storageMock.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "assets/logo.png", contentType: "image/png" }),
    );
    expect(storageMock.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "references/guide.md",
        contentType: "text/markdown",
      }),
    );
  });

  it("allows type stubs, notebooks, shell variants, and ICO images", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", createdBy: "user-1" },
    ]);

    const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
    const res = await upload(
      [
        { path: "types/probe.pyi", content: "def probe() -> None: ...\n" },
        { path: "notebooks/analysis.ipynb", content: '{"cells":[]}\n' },
        { path: "scripts/setup.bash", content: "echo hi\n" },
        { path: "scripts/setup.zsh", content: "echo hi\n" },
        { path: "assets/favicon.ico", content: ico },
      ],
      null,
    );

    expect(res.status).toBe(201);
    expect(
      storageMock.putFile.mock.calls
        .map((args: unknown[]) => (args[0] as { path: string }).path)
        .sort(),
    ).toEqual([
      "assets/favicon.ico",
      "notebooks/analysis.ipynb",
      "scripts/setup.bash",
      "scripts/setup.zsh",
      "types/probe.pyi",
    ]);
    expect(storageMock.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "assets/favicon.ico",
        contentType: "image/x-icon",
      }),
    );
    expect(storageMock.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "notebooks/analysis.ipynb",
        contentType: "application/json",
      }),
    );
  });

  it("imports files under any folder name plus root-level files, skipping dotfiles", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", createdBy: "user-1" },
    ]);

    const res = await upload(
      [
        { path: "lib/helper.py", content: "print('hi')\n" },
        { path: "rules/style.md", content: "# Style\n" },
        // Root-level files are kept; dotfiles remain folder noise.
        { path: "LICENSE", content: "MIT\n" },
        { path: ".gitignore", content: "*.pyc\n" },
      ],
      null,
    );

    expect(res.status).toBe(201);
    expect(
      storageMock.putFile.mock.calls
        .map((args: unknown[]) => (args[0] as { path: string }).path)
        .sort(),
    ).toEqual(["LICENSE", "lib/helper.py", "rules/style.md"]);
    expect((await res.json()).filesImported).toBe(3);
  });

  it("rejects an entry path that tries to escape the folder, before writing", async () => {
    dbMock.$enqueue([]);

    const res = await upload(
      [{ path: "scripts/../../etc/shadow", content: "root\n" }],
      null,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/Invalid path in upload/);
    expect(storageMock.createCustom).not.toHaveBeenCalled();
  });

  it("rejects an upload where one path is both a file and a folder", async () => {
    const res = await upload(
      [
        { path: "foo", content: "root file\n" },
        { path: "foo/bar.md", content: "# nested\n" },
      ],
      null,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/both a file and a folder/);
    expect(storageMock.createCustom).not.toHaveBeenCalled();
  });

  it("rejects executables, media, archives, and documents with reasons", async () => {
    const res = await upload(
      [
        { path: "setup.exe", content: "MZ" },
        { path: "demo.mp4", content: "video" },
        { path: "bundle.zip", content: "zip" },
        { path: "template.docx", content: "docx" },
      ],
      null,
    );

    expect(res.status).toBe(400);
    const message = (await res.json()).message as string;
    expect(message).toMatch(/setup\.exe.*executable file/);
    expect(message).toMatch(/demo\.mp4.*video file/);
    expect(message).toMatch(/bundle\.zip.*archive file/);
    expect(message).toMatch(/template\.docx.*Word document/);
    expect(storageMock.createCustom).not.toHaveBeenCalled();
  });

  it("skips dotfiles and generated noise and reports them", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", createdBy: "user-1" },
    ]);

    const res = await upload(
      [
        { path: "references/guide.md", content: "# Guide\n" },
        { path: ".env", content: "SECRET=1" },
        { path: ".github/workflows/ci.yml", content: "name: CI" },
        { path: "__MACOSX/foo", content: "x" },
        { path: "scripts/__pycache__/helper.cpython-311.pyc", content: "x" },
        { path: "build/helper.pyc", content: "x" },
        { path: "debug.log", content: "x" },
        { path: "notes.md~", content: "x" },
        { path: "yarn.lock", content: "x" },
        { path: "project.iml", content: "x" },
        { path: "venv/lib/python3.11/site-packages/native.so", content: "x" },
        { path: "dist/pkg-1.0.whl", content: "x" },
        { path: "Thumbs.db", content: "x" },
      ],
      null,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect([...body.skipped].sort()).toEqual(
      [
        ".env",
        ".github/workflows/ci.yml",
        "__MACOSX/foo",
        "scripts/__pycache__/helper.cpython-311.pyc",
        "build/helper.pyc",
        "debug.log",
        "notes.md~",
        "yarn.lock",
        "project.iml",
        "venv/lib/python3.11/site-packages/native.so",
        "dist/pkg-1.0.whl",
        "Thumbs.db",
      ].sort(),
    );
    expect(
      storageMock.putFile.mock.calls
        .map((args: unknown[]) => (args[0] as { path: string }).path)
        .sort(),
    ).toEqual(["references/guide.md"]);
  });

  it("rejects binary content disguised as a text file", async () => {
    const res = await upload(
      [{ path: "notes.md", content: Buffer.from([0x68, 0x00, 0x69]) }],
      null,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/notes\.md.*NUL bytes/);
    expect(storageMock.createCustom).not.toHaveBeenCalled();
  });

  it("rejects image bytes that do not match the extension", async () => {
    const res = await upload(
      [{ path: "assets/logo.png", content: "not a png" }],
      null,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/logo\.png.*PNG content/);
    expect(storageMock.createCustom).not.toHaveBeenCalled();
  });

  it("imports a skill whose declared scripts-on-db file is present", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", createdBy: "user-1" },
    ]);

    const res = await upload(
      [
        {
          path: "scripts/reports/sales.sql",
          content: "SELECT * FROM sales\n",
        },
      ],
      'scripts-on-db: ["reports/sales.sql"]',
    );

    expect(res.status).toBe(201);
    expect(storageMock.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "scripts/reports/sales.sql" }),
    );
  });

  it("rejects a scripts-on-db declaration with no backing file", async () => {
    dbMock.$enqueue([]);

    const res = await upload(
      [{ path: "scripts/reports/other.sql", content: "SELECT 1\n" }],
      'scripts-on-db: ["reports/sales.sql"]',
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(
      /scripts-on-db declares missing file\(s\): scripts\/reports\/sales\.sql/,
    );
    expect(storageMock.createCustom).not.toHaveBeenCalled();
  });

  it("imports a skill whose SKILL.md wraps its description over several lines", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", createdBy: "user-1" },
    ]);

    // Third-party packs wrap long descriptions as a YAML plain multi-line
    // scalar and carry nested metadata; rejecting them made the folder
    // unimportable with an error that named no file.
    const skillMd = `---
name: probe-skill
description:
  React Native and Expo best practices for building performant mobile apps. Use
  when building React Native components or optimizing list performance.
license: MIT
metadata:
  author: vercel
  version: '1.0.0'
---

body
`;

    const res = await upload(
      [{ path: "references/guide.md", content: "# Guide\n" }],
      null,
      skillMd,
    );

    expect(res.status).toBe(201);
    expect(storageMock.createCustom).toHaveBeenCalledWith(
      expect.objectContaining({ skillMd, visibility: "private", createdBy: "user-1" }),
    );
  });

  it("reports the offending SKILL.md line when the frontmatter is malformed", async () => {
    dbMock.$enqueue([]);

    const res = await upload(
      [{ path: "references/guide.md", content: "# Guide\n" }],
      null,
      "---\nname: probe-skill\ndescription: Enough for the checks.\nno colon here\n---\n\nbody\n",
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(
      /SKILL\.md line 4: invalid frontmatter line/,
    );
    expect(storageMock.createCustom).not.toHaveBeenCalled();
  });

  it("leaves undeclared scripts alone", async () => {
    dbMock.$enqueue([], [
      { id: "skill-1", name: "probe-skill", createdBy: "user-1" },
    ]);

    const res = await upload(
      [{ path: "scripts/probe.sh", content: Buffer.from([0xc4, 0xe3, 0x0a]) }],
      null,
    );

    expect(res.status).toBe(201);
  });
});
