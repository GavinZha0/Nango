import { describe, it, expect } from "vitest";
import {
  classifyChatAttachment,
  estimateBase64ByteLength,
  formatAttachmentByteLimit,
  formatInlineTextAttachment,
  resolveChatAttachmentMimeType,
  type ChatAttachmentLimits,
} from "@/lib/chat/attachments";
import { transformBuiltinChatAttachments } from "@/lib/chat/attachments.server";
import { ApiError } from "@/lib/http/route-handlers";

const TEST_LIMITS: ChatAttachmentLimits = {
  imageMaxBytes: 3 * 1024 * 1024,
  textMaxBytes: 256 * 1024,
  maxAttachmentsPerMessage: 5,
};

describe("chat attachment policy", () => {
  it("classifies allowed images and text files and rejects unsupported types", () => {
    expect(classifyChatAttachment("shot.png", "image/png")).toBe("image");
    expect(classifyChatAttachment("photo.JPG", "")).toBe("image");
    expect(classifyChatAttachment("notes.md", "")).toBe("text");
    expect(classifyChatAttachment("data.json", "application/json")).toBe("text");
    expect(classifyChatAttachment("query.sql", "application/octet-stream")).toBe("text");
    expect(classifyChatAttachment("paste", "text/plain")).toBe("text");

    // Rejected types
    expect(classifyChatAttachment("icon.svg", "image/svg+xml")).toBeNull();
    expect(classifyChatAttachment("report.pdf", "application/pdf")).toBeNull();
    expect(classifyChatAttachment("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBeNull();
    expect(classifyChatAttachment("archive.zip", "application/zip")).toBeNull();
    expect(classifyChatAttachment("app.exe", "application/octet-stream")).toBeNull();
  });

  it("normalizes MIME types and formats byte limits", () => {
    expect(resolveChatAttachmentMimeType("notes.md", "", "text")).toBe("text/plain");
    expect(resolveChatAttachmentMimeType("data.json", "application/json", "text")).toBe("application/json");
    expect(resolveChatAttachmentMimeType("pic.webp", "", "image")).toBe("image/webp");
    expect(formatAttachmentByteLimit(3 * 1024 * 1024)).toBe("3 MB");
    expect(formatAttachmentByteLimit(256 * 1024)).toBe("256 KB");
    expect(estimateBase64ByteLength(Buffer.from("hello").toString("base64"))).toBe(5);
  });

  it("uses a backtick fence longer than internal backticks when inlining text", () => {
    const wrapped = formatInlineTextAttachment("doc.md", "```js\nconsole.log(1)\n```");
    expect(wrapped).toContain("[Attached file: doc.md]");
    expect(wrapped).toContain("````markdown\n```js\nconsole.log(1)\n```\n````");
  });
});

describe("transformBuiltinChatAttachments", () => {
  it("inlines text document parts into fenced text and preserves valid images", () => {
    const csvBase64 = Buffer.from("name,score\nalice,95\n", "utf8").toString("base64");
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

    const { messages, changed } = transformBuiltinChatAttachments(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Check both files" },
            {
              type: "document",
              source: { type: "data", value: csvBase64, mimeType: "" },
              metadata: { filename: "scores.csv" },
            },
            {
              type: "image",
              source: { type: "data", value: pngBase64, mimeType: "image/png" },
              metadata: { filename: "chart.png" },
            },
          ],
        },
      ],
      TEST_LIMITS,
    );

    expect(changed).toBe(true);
    const parts = messages[0]?.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: "text", text: "Check both files" });
    expect(parts[1]?.type).toBe("text");
    expect(parts[1]?.text).toContain("[Attached file: scores.csv]");
    expect(parts[1]?.text).toContain("alice,95");
    expect(parts[2]).toMatchObject({
      type: "image",
      source: { type: "data", value: pngBase64, mimeType: "image/png" },
    });
  });

  it("rejects oversized text files, oversized images, disallowed types, and binary-disguised text", () => {
    const bigText = Buffer.alloc(300, "a").toString("base64");
    expect(() =>
      transformBuiltinChatAttachments(
        [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "data", value: bigText, mimeType: "text/plain" },
                metadata: { filename: "big.txt" },
              },
            ],
          },
        ],
        { ...TEST_LIMITS, textMaxBytes: 100 },
      ),
    ).toThrow(ApiError);

    const binaryWithNul = Buffer.from([0x41, 0x00, 0x42]).toString("base64");
    expect(() =>
      transformBuiltinChatAttachments(
        [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "data", value: binaryWithNul, mimeType: "text/plain" },
                metadata: { filename: "fake.txt" },
              },
            ],
          },
        ],
        TEST_LIMITS,
      ),
    ).toThrow(/UTF-8/);

    expect(() =>
      transformBuiltinChatAttachments(
        [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "data", value: "JVBERi0=", mimeType: "application/pdf" },
                metadata: { filename: "doc.pdf" },
              },
            ],
          },
        ],
        TEST_LIMITS,
      ),
    ).toThrow(/Unsupported file type/);

    expect(() =>
      transformBuiltinChatAttachments(
        [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "data", value: Buffer.alloc(200, 1).toString("base64"), mimeType: "image/png" },
                metadata: { filename: "large.png" },
              },
            ],
          },
        ],
        { ...TEST_LIMITS, imageMaxBytes: 100 },
      ),
    ).toThrow(/exceeds/);
  });

  it("enforces max attachment count per message", () => {
    const tiny = Buffer.from("hi").toString("base64");
    const content = Array.from({ length: 6 }, (_, i) => ({
      type: "document",
      source: { type: "data", value: tiny, mimeType: "text/plain" },
      metadata: { filename: `f${i}.txt` },
    }));

    expect(() =>
      transformBuiltinChatAttachments([{ role: "user", content }], TEST_LIMITS),
    ).toThrow(/At most 5 files/);
  });
});
