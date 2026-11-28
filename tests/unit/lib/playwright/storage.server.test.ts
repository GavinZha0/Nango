import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let mockHostFileRoot: string | null = null;

vi.mock("@/lib/host-files/jail.server", () => ({
  getHostFileRoot: () => mockHostFileRoot,
}));

import {
  ensurePlaywrightOutputDir,
  resolvePlaywrightOutputDir,
  sanitizePlaywrightFilename,
  readPlaywrightScreenshot,
} from "@/lib/playwright/storage.server";
import { GET } from "@/app/api/media/playwright-files/route";
import { createMockRequest } from "tests/unit/helpers";

describe("Playwright Storage Server", () => {
  let tmpRoot: string;
  let pwDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-root-"));
    pwDir = path.join(tmpRoot, "playwright");
    fs.mkdirSync(pwDir, { recursive: true });
    mockHostFileRoot = tmpRoot;
  });

  afterEach(() => {
    mockHostFileRoot = null;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe("resolvePlaywrightOutputDir", () => {
    it("resolves <host.file.root>/playwright when host.file.root is configured", () => {
      expect(resolvePlaywrightOutputDir()).toBe(path.join(path.resolve(tmpRoot), "playwright"));
    });

    it("returns null when host.file.root is unconfigured", () => {
      mockHostFileRoot = null;
      expect(resolvePlaywrightOutputDir()).toBeNull();
    });

    it("creates the playwright subdirectory in ensurePlaywrightOutputDir", () => {
      fs.rmSync(pwDir, { recursive: true, force: true });
      const created = ensurePlaywrightOutputDir();
      expect(created).toBe(path.join(path.resolve(tmpRoot), "playwright"));
      expect(fs.existsSync(pwDir)).toBe(true);
    });
  });

  describe("sanitizePlaywrightFilename", () => {
    it("cleans relative prefixes", () => {
      expect(sanitizePlaywrightFilename("./mypage")).toBe("mypage");
      expect(
        sanitizePlaywrightFilename(".playwright-mcp/page-2026-08-23.png"),
      ).toBe("page-2026-08-23.png");
      expect(sanitizePlaywrightFilename("/app/.output/test.webp")).toBe(
        "test.webp",
      );
    });

    it("prevents directory traversal by returning base filename", () => {
      expect(sanitizePlaywrightFilename("../../etc/passwd")).toBe("passwd");
      expect(sanitizePlaywrightFilename("..\\..\\secret.png")).toBe(
        "secret.png",
      );
    });
  });

  describe("readPlaywrightScreenshot", () => {
    it("reads existing PNG screenshot from <host.file.root>/playwright", async () => {
      const filePath = path.join(pwDir, "shot1.png");
      const dummyData = Buffer.from("fake-png-data");
      fs.writeFileSync(filePath, dummyData);

      const res = await readPlaywrightScreenshot("shot1.png");
      expect(res).not.toBeNull();
      expect(res?.mimeType).toBe("image/png");
      expect(res?.filename).toBe("shot1.png");
      expect(res?.buffer.equals(dummyData)).toBe(true);
    });

    it("probes extension automatically for extensionless filenames", async () => {
      const filePath = path.join(pwDir, "mypage.webp");
      const dummyData = Buffer.from("fake-webp-data");
      fs.writeFileSync(filePath, dummyData);

      const res = await readPlaywrightScreenshot("./mypage");
      expect(res).not.toBeNull();
      expect(res?.mimeType).toBe("image/webp");
      expect(res?.filename).toBe("mypage.webp");
      expect(res?.buffer.equals(dummyData)).toBe(true);
    });

    it("returns null for non-existent files or unconfigured root", async () => {
      expect(await readPlaywrightScreenshot("non-existent.png")).toBeNull();
      mockHostFileRoot = null;
      expect(await readPlaywrightScreenshot("shot1.png")).toBeNull();
    });
  });

  describe("GET /api/media/playwright-files route", () => {
    it("returns 400 when file param is missing", async () => {
      const req = createMockRequest("/api/media/playwright-files");
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("MISSING_PARAM");
    });

    it("returns 404 ROOT_NOT_CONFIGURED when host.file.root is unset", async () => {
      mockHostFileRoot = null;
      const req = createMockRequest("/api/media/playwright-files", {
        searchParams: { file: "missing.png" },
      });
      const res = await GET(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("ROOT_NOT_CONFIGURED");
    });

    it("returns 404 when file does not exist", async () => {
      const req = createMockRequest("/api/media/playwright-files", {
        searchParams: { file: "missing.png" },
      });
      const res = await GET(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("FILE_NOT_FOUND");
      expect(json.message).not.toContain("docker-compose.yaml");
    });

    it("returns 200 with image stream and caching headers for valid file", async () => {
      const filePath = path.join(pwDir, "test.png");
      fs.writeFileSync(filePath, Buffer.from("test-content"));

      const req = createMockRequest("/api/media/playwright-files", {
        searchParams: { file: "test.png" },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toContain("max-age=86400");
    });
  });
});
