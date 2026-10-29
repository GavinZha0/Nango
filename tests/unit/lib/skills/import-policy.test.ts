import { describe, expect, it } from "vitest";

import {
  classifyEditorCreatePath,
  classifyEditorRenamePath,
  classifyImportPath,
  validateImageBytes,
} from "@/lib/skills/import-policy";

describe("classifyImportPath", () => {
  it.each([
    "references/guide.md",
    "LICENSE",
    "README",
    "Dockerfile",
    "scripts/lib/probe.py",
    "types/probe.pyi",
    "notebooks/analysis.ipynb",
    "scripts/setup.bash",
    "scripts/setup.zsh",
    "data/table.csv",
    "templates/page.html",
  ])("allows text file %s", (path) => {
    expect(classifyImportPath(path).action).toBe("allow-text");
  });

  it.each([
    "assets/logo.png",
    "assets/photo.jpeg",
    "assets/anim.gif",
    "assets/modern.webp",
    "assets/favicon.ico",
  ])("allows image %s", (path) => {
    expect(classifyImportPath(path).action).toBe("allow-image");
  });

  it.each([
    ".env",
    ".github/workflows/ci.yml",
    "references/.env.local",
    "__MACOSX/foo",
    "node_modules/pkg/index.js",
    "__pycache__/probe.cpython-311.pyc",
    "scripts/__pycache__/probe.cpython-311.pyc",
    "probe.pyc",
    "build/probe.pyc",
    "probe.pyo",
    "debug.log",
    "backup.tmp",
    "backup.temp",
    "backup.bak",
    "patch.orig",
    "patch.rej",
    "notes.swp",
    "notes.swo",
    "notes.md~",
    "tsconfig.tsbuildinfo",
    "app.js.map",
    "project.iml",
    "solution.suo",
    "yarn.lock",
    "bun.lockb",
    "pkg-1.0.whl",
    "pkg-1.0.egg",
    "scripts/node_modules/pkg/index.js",
    "venv/lib/python3.11/site-packages/native.so",
    "virtualenv/pyvenv.cfg",
    "lib/pkg.egg-info/PKG-INFO",
    "lib/pkg.dist-info/METADATA",
    "ehthumbs.db",
    "Thumbs.db",
    "desktop.ini",
  ])("ignores %s", (path) => {
    expect(classifyImportPath(path).action).toBe("ignore");
  });

  it.each([
    ["setup.exe", "executable file"],
    ["lib.dll", "native library"],
    ["assets/mystery.bin", "binary file"],
    ["video.mp4", "video file"],
    ["audio.mp3", "audio file"],
    ["bundle.zip", "archive file"],
    ["font.woff2", "font file"],
    ["template.docx", "Word document"],
    ["doc.pdf", "PDF document"],
    ["unknown.xyz", "unsupported file type"],
  ])("blocks %s with a reason", (path, reason) => {
    const result = classifyImportPath(path);
    expect(result.action).toBe("block");
    expect(result.reason).toBe(reason);
  });
});

describe("editor policies", () => {
  it("allows text creation but refuses images", () => {
    expect(classifyEditorCreatePath("references/guide.md").action).toBe(
      "allow-text",
    );
    const image = classifyEditorCreatePath("assets/logo.png");
    expect(image.action).toBe("block");
    expect(image.reason).toMatch(/added through a folder import/);
  });

  it("allows text/image renames but refuses executables", () => {
    expect(classifyEditorRenamePath("notes.md").action).toBe("allow-text");
    expect(classifyEditorRenamePath("logo.png").action).toBe("allow-image");
    expect(classifyEditorRenamePath("setup.exe").action).toBe("block");
    expect(classifyEditorRenamePath(".env").action).toBe("block");
  });
});

describe("content validation", () => {
  it("checks image magic bytes", () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const gif = Buffer.from("GIF89a");
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP"),
    ]);
    const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);

    expect(validateImageBytes("logo.png", png)).toBeNull();
    expect(validateImageBytes("photo.jpg", jpeg)).toBeNull();
    expect(validateImageBytes("anim.gif", gif)).toBeNull();
    expect(validateImageBytes("modern.webp", webp)).toBeNull();
    expect(validateImageBytes("favicon.ico", ico)).toBeNull();
  });

  it("rejects a text file renamed to an image extension", () => {
    expect(
      validateImageBytes("logo.png", Buffer.from("not an image")),
    ).toMatch(/PNG content/);
    expect(
      validateImageBytes("logo.png", Buffer.from([0x89, 0x50])),
    ).toMatch(/too short/);
    expect(
      validateImageBytes("favicon.ico", Buffer.from("not an icon")),
    ).toMatch(/ICO content/);
  });
});
