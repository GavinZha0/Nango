import { describe, it, expect } from "vitest";
import {
  extractWebAutoImages,
  formatWebAutoOutputForDisplay,
  sanitizeWebAutoOutput,
} from "@/lib/web-auto/image-extractor";

describe("extractWebAutoImages", () => {
  it("extracts single snapshot / screenshot from structured output.result", () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const output = {
      result: {
        success: true,
        screenshot: `data:image/png;base64,${pngBase64}`,
      },
      page: {
        url: "https://example.com",
      },
    };

    const images = extractWebAutoImages(output);
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe("screenshot");
    expect(images[0].format).toBe("png");
    expect(images[0].rawBase64).toBe(pngBase64);
  });

  it("extracts images array with multiple formats (jpeg, webp, png)", () => {
    const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const jpegData = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    const webpData = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

    const output = {
      result: {
        screenshots: [
          `data:image/png;base64,${pngData}`,
          `data:image/jpeg;base64,${jpegData}`,
          `data:image/webp;base64,${webpData}`,
        ],
      },
    };

    const images = extractWebAutoImages(output);
    expect(images).toHaveLength(3);
    expect(images[0].format).toBe("png");
    expect(images[1].format).toBe("jpeg");
    expect(images[2].format).toBe("webp");
    expect(images[0].name).toBe("screenshots[0]");
    expect(images[1].name).toBe("screenshots[1]");
    expect(images[2].name).toBe("screenshots[2]");
  });

  it("extracts images from plural/singular keys: snapshot, snapshots, image, images", () => {
    const sample = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const output = {
      result: {
        snapshot: `data:image/png;base64,${sample}`,
        images: [`data:image/png;base64,${sample}2`],
      },
    };

    const images = extractWebAutoImages(output);
    expect(images.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts filename-based screenshots and builds streaming URLs", () => {
    const output = {
      result: {
        success: true,
        screenshot: "githubhome.png",
      },
    };

    const images = extractWebAutoImages(output);
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe("screenshot");
    expect(images[0].filename).toBe("githubhome.png");
    expect(images[0].src).toBe("/api/media/playwright-files?file=githubhome.png");
    expect(images[0].format).toBe("png");
    expect(images[0].rawBase64).toBe("");
  });

  it("extracts array of image filenames and sanitizes relative path tokens", () => {
    const output = {
      result: {
        snapshots: [
          "./step1.png",
          "/app/.output/step2.webp",
          ".playwright-mcp/step3.jpg",
        ],
      },
    };

    const images = extractWebAutoImages(output);
    expect(images).toHaveLength(3);
    expect(images[0].filename).toBe("step1.png");
    expect(images[0].src).toBe("/api/media/playwright-files?file=step1.png");
    expect(images[0].format).toBe("png");

    expect(images[1].filename).toBe("step2.webp");
    expect(images[1].src).toBe("/api/media/playwright-files?file=step2.webp");
    expect(images[1].format).toBe("webp");

    expect(images[2].filename).toBe("step3.jpg");
    expect(images[2].src).toBe("/api/media/playwright-files?file=step3.jpg");
    expect(images[2].format).toBe("jpeg");
  });

  it("supports mixed Base64 and filename outputs simultaneously", () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const output = {
      result: {
        screenshot: `data:image/png;base64,${pngBase64}`,
        snapshot: "dashboard.png",
      },
    };

    const images = extractWebAutoImages(output);
    expect(images).toHaveLength(2);
    expect(images[0].rawBase64).toBe(pngBase64);
    expect(images[1].filename).toBe("dashboard.png");
    expect(images[1].src).toBe("/api/media/playwright-files?file=dashboard.png");
  });

  it("returns empty array when output has no images", () => {
    const output = {
      result: {
        success: true,
        count: 42,
      },
    };
    expect(extractWebAutoImages(output)).toEqual([]);
    expect(extractWebAutoImages(null)).toEqual([]);
    expect(extractWebAutoImages("not json")).toEqual([]);
  });
});

describe("sanitizeWebAutoOutput & formatWebAutoOutputForDisplay", () => {
  it("truncates long data:image base64 strings to placeholder", () => {
    const pngBase64 = "A".repeat(500);
    const output = {
      result: {
        screenshot: `data:image/png;base64,${pngBase64}`,
        title: "Test Page",
      },
    };

    const formatted = formatWebAutoOutputForDisplay(output);
    expect(formatted).toContain("base64 string]");
    expect(formatted).toContain("Test Page");
    expect(formatted).not.toContain(pngBase64);

    const sanitized = sanitizeWebAutoOutput(output) as Record<string, { screenshot: string; title: string }>;
    expect(sanitized.result.title).toBe("Test Page");
    expect(sanitized.result.screenshot).toMatch(/^\[\d+KB image\/png base64 string\]$/);
  });

  it("handles raw base64 string without data: prefix", () => {
    const rawBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".repeat(5);
    const output = {
      rawImage: rawBase64,
    };

    const sanitized = sanitizeWebAutoOutput(output) as Record<string, string>;
    expect(sanitized.rawImage).toMatch(/^\[\d+KB image\/png base64 string\]$/);
  });
});
