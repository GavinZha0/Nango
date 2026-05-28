import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  extractRunInputFromBody,
  extractTrailingToolResults,
  stringifyToolContent,
} from "@/lib/runner/extract-run-input";

describe("stringifyToolContent", () => {
  it("passes strings through verbatim", () => {
    expect(stringifyToolContent("Go")).toBe("Go");
    expect(stringifyToolContent("")).toBe("");
  });

  it("returns empty for null / undefined", () => {
    expect(stringifyToolContent(null)).toBe("");
    expect(stringifyToolContent(undefined)).toBe("");
  });

  it("JSON-stringifies plain objects", () => {
    expect(stringifyToolContent({ value: "go", label: "Go" })).toBe(
      '{"value":"go","label":"Go"}',
    );
  });

  it("JSON-stringifies arrays", () => {
    expect(stringifyToolContent([1, 2, 3])).toBe("[1,2,3]");
  });

  it("falls back to String() for unstringifiable values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(stringifyToolContent(cyclic)).toMatch(/object/);
  });

  it("stringifies booleans and numbers via JSON.stringify", () => {
    expect(stringifyToolContent(true)).toBe("true");
    expect(stringifyToolContent(42)).toBe("42");
  });
});

describe("extractTrailingToolResults", () => {
  it("returns empty when tail is a user message", () => {
    expect(
      extractTrailingToolResults([
        { role: "user", content: "hi" },
      ]),
    ).toEqual([]);
  });

  it("returns empty when tail is an assistant message", () => {
    expect(
      extractTrailingToolResults([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]),
    ).toEqual([]);
  });

  it("collects a single trailing tool message", () => {
    expect(
      extractTrailingToolResults([
        { role: "user", content: "pick one" },
        { role: "assistant", content: "" },
        { role: "tool", toolCallId: "call_1", content: "Go" },
      ]),
    ).toEqual([{ toolCallId: "call_1", content: "Go" }]);
  });

  it("collects multiple trailing tool messages in body order", () => {
    expect(
      extractTrailingToolResults([
        { role: "user", content: "do things" },
        { role: "tool", toolCallId: "call_a", content: "A" },
        { role: "tool", toolCallId: "call_b", content: "B" },
      ]),
    ).toEqual([
      { toolCallId: "call_a", content: "A" },
      { toolCallId: "call_b", content: "B" },
    ]);
  });

  it("stops at the first non-tool message scanning from the tail", () => {
    expect(
      extractTrailingToolResults([
        { role: "tool", toolCallId: "old_call", content: "OLD" },
        { role: "user", content: "new question" },
        { role: "tool", toolCallId: "new_call", content: "NEW" },
      ]),
    ).toEqual([{ toolCallId: "new_call", content: "NEW" }]);
  });

  it("skips tool messages without a toolCallId", () => {
    expect(
      extractTrailingToolResults([
        { role: "tool", content: "no-id" }, // skipped
        { role: "tool", toolCallId: "call_1", content: "kept" },
      ]),
    ).toEqual([{ toolCallId: "call_1", content: "kept" }]);
  });

  it("stringifies non-string tool content", () => {
    expect(
      extractTrailingToolResults([
        { role: "tool", toolCallId: "call_1", content: { value: "go", label: "Go" } },
      ]),
    ).toEqual([{ toolCallId: "call_1", content: '{"value":"go","label":"Go"}' }]);
  });
});

describe("extractRunInputFromBody", () => {
  it("returns empty defaults on empty body", () => {
    expect(extractRunInputFromBody({})).toEqual({
      task: "",
      threadId: undefined,
      userMessageId: undefined,
      triggeringToolResults: [],
    });
  });

  it("reads threadId from the body", () => {
    expect(
      extractRunInputFromBody({ threadId: "abc-123", messages: [] }),
    ).toMatchObject({ threadId: "abc-123" });
  });

  it("ignores non-string threadId", () => {
    expect(
      extractRunInputFromBody({ threadId: 42 as unknown, messages: [] }),
    ).toMatchObject({ threadId: undefined });
  });

  it("returns the last user message text + id on a normal chat turn", () => {
    const result = extractRunInputFromBody({
      threadId: "t-1",
      messages: [
        { id: "msg-a", role: "user", content: "first" },
        { id: "msg-b", role: "assistant", content: "..." },
        { id: "msg-c", role: "user", content: "second" },
      ],
    });
    expect(result).toEqual({
      task: "second",
      threadId: "t-1",
      userMessageId: "msg-c",
      triggeringToolResults: [],
    });
  });

  it("treats trailing tool messages as the continuation trigger", () => {
    const result = extractRunInputFromBody({
      threadId: "t-1",
      messages: [
        { id: "msg-a", role: "user", content: "show a language picker" },
        { id: "msg-b", role: "assistant", content: "" },
        { role: "tool", toolCallId: "call_x", content: "Go" },
      ],
    });
    expect(result).toEqual({
      task: "Go",
      threadId: "t-1",
      userMessageId: undefined,
      triggeringToolResults: [{ toolCallId: "call_x", content: "Go" }],
    });
  });

  it("uses the FIRST trailing tool result as the task when there are several", () => {
    const result = extractRunInputFromBody({
      messages: [
        { role: "user", content: "do two things" },
        { role: "tool", toolCallId: "call_a", content: "A" },
        { role: "tool", toolCallId: "call_b", content: "B" },
      ],
    });
    expect(result.task).toBe("A");
    expect(result.triggeringToolResults).toEqual([
      { toolCallId: "call_a", content: "A" },
      { toolCallId: "call_b", content: "B" },
    ]);
    expect(result.userMessageId).toBeUndefined();
  });

  it("caps very long task text at 1000 chars (continuation)", () => {
    const long = "x".repeat(2000);
    const result = extractRunInputFromBody({
      messages: [
        { role: "user", content: "..." },
        { role: "tool", toolCallId: "call_x", content: long },
      ],
    });
    expect(result.task.length).toBe(1000);
  });

  it("caps very long task text at 1000 chars (normal chat)", () => {
    const long = "y".repeat(2000);
    const result = extractRunInputFromBody({
      messages: [{ role: "user", content: long }],
    });
    expect(result.task.length).toBe(1000);
  });

  it("extracts text from array-shape user content (multi-part)", () => {
    const result = extractRunInputFromBody({
      messages: [
        {
          id: "msg-multipart",
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", url: "ignored" },
            { type: "text", text: "world" },
          ],
        },
      ],
    });
    expect(result.task).toBe("hello\nworld");
    expect(result.userMessageId).toBe("msg-multipart");
  });

  it("falls back gracefully when no user OR tool messages exist", () => {
    const result = extractRunInputFromBody({
      messages: [{ role: "assistant", content: "..." }],
    });
    expect(result.task).toBe("");
    expect(result.userMessageId).toBeUndefined();
    expect(result.triggeringToolResults).toEqual([]);
  });
});
