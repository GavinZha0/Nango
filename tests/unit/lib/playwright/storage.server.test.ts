import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  resolvePlaywrightOutputDir,
  sanitizePlaywrightFilename,
  readPlaywrightScreenshot,
} from "@/lib/playwright/storage.server";
import { GET } from "@/app/api/media/playwright-files/route";
import { NextRequest } from "next/server";

describe("Playwright Storage Server", () => {
  let tmpDir: string;
  const originalEnv = process.env.PLAYWRIGHT_OUTPUT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-test-"));
    process.env.PLAYWRIGHT_OUTPUT_DIR = tmpDir;
  });

  afterEach(() => {
    process.env.PLAYWRIGHT_OUTPUT_DIR = originalEnv;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe("resolvePlaywrightOutputDir", () => {
    it("returns environment variable path when configured", () => {
      expect(resolvePlaywrightOutputDir()).toBe(path.resolve(tmpDir));
    });

    it("falls back to default path when env is unset", () => {
      delete process.env.PLAYWRIGHT_OUTPUT_DIR;
      expect(resolvePlaywrightOutputDir()).toBe(
        path.join(process.cwd(), ".cache", "playwright"),
      );
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
    it("reads existing PNG screenshot", async () => {
      const filePath = path.join(tmpDir, "shot1.png");
      const dummyData = Buffer.from("fake-png-data");
      fs.writeFileSync(filePath, dummyData);

      const res = await readPlaywrightScreenshot("shot1.png");
      expect(res).not.toBeNull();
      expect(res?.mimeType).toBe("image/png");
      expect(res?.filename).toBe("shot1.png");
      expect(res?.buffer.equals(dummyData)).toBe(true);
    });

    it("probes extension automatically for extensionless filenames", async () => {
      const filePath = path.join(tmpDir, "mypage.webp");
      const dummyData = Buffer.from("fake-webp-data");
      fs.writeFileSync(filePath, dummyData);

      const res = await readPlaywrightScreenshot("./mypage");
      expect(res).not.toBeNull();
      expect(res?.mimeType).toBe("image/webp");
      expect(res?.filename).toBe("mypage.webp");
      expect(res?.buffer.equals(dummyData)).toBe(true);
    });

    it("returns null for non-existent files", async () => {
      const res = await readPlaywrightScreenshot("non-existent.png");
      expect(res).toBeNull();
    });
  });

  describe("GET /api/media/playwright-files route", () => {
    it("returns 400 when file param is missing", async () => {
      const req = new NextRequest("http://localhost:9300/api/media/playwright-files");
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("MISSING_PARAM");
    });

    it("returns 404 when file does not exist", async () => {
      const req = new NextRequest(
        "http://localhost:9300/api/media/playwright-files?file=missing.png",
      );
      const res = await GET(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("FILE_NOT_FOUND");
    });

    it("returns 200 with image stream and caching headers for valid file", async () => {
      const filePath = path.join(tmpDir, "test.png");
      fs.writeFileSync(filePath, Buffer.from("test-content"));

      const req = new NextRequest(
        "http://localhost:9300/api/media/playwright-files?file=test.png",
      );
      const res = await GET(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toContain("max-age=86400");
    });
  });
});
