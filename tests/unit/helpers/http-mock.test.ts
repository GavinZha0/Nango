import { describe, it, expect } from "vitest";
import { createMockRequest } from "./http-mock";

describe("http-mock helper", () => {
  it("creates a basic GET request with absolute URL", () => {
    const req = createMockRequest("http://localhost:9300/api/test");
    expect(req.url).toBe("http://localhost:9300/api/test");
    expect(req.method).toBe("GET");
  });

  it("resolves relative URL using localhost:9300", () => {
    const req = createMockRequest("/api/test-relative");
    expect(req.url).toBe("http://localhost:9300/api/test-relative");
  });

  it("appends searchParams properly", () => {
    const req = createMockRequest("/api/items", {
      searchParams: { page: "1", filter: "active" },
    });
    const url = new URL(req.url);
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("filter")).toBe("active");
  });

  it("serializes JSON body and sets Content-Type header", async () => {
    const req = createMockRequest("/api/items", {
      method: "POST",
      body: { name: "item-1", score: 99 },
    });
    expect(req.method).toBe("POST");
    expect(req.headers.get("Content-Type")).toBe("application/json");

    const json = await req.json();
    expect(json).toEqual({ name: "item-1", score: 99 });
  });

  it("allows custom headers overriding defaults", () => {
    const req = createMockRequest("/api/items", {
      headers: { "x-custom-header": "test-val" },
    });
    expect(req.headers.get("x-custom-header")).toBe("test-val");
  });

  it("infers POST when body is provided without explicit method", () => {
    const req = createMockRequest("/api/items", {
      body: { action: "create" },
    });
    expect(req.method).toBe("POST");
  });

  it("passes raw string body directly without double JSON serialization", async () => {
    const rawString = "raw text payload";
    const req = createMockRequest("/api/raw", {
      method: "POST",
      body: rawString,
    });
    const text = await req.text();
    expect(text).toBe(rawString);
  });

  it("skips body when method is GET or HEAD even if body is provided", () => {
    const reqGet = createMockRequest("/api/items", {
      method: "GET",
      body: { shouldBeIgnored: true },
    });
    expect(reqGet.method).toBe("GET");
    expect(reqGet.body).toBeNull();

    const reqHead = createMockRequest("/api/items", {
      method: "HEAD",
      body: { shouldBeIgnored: true },
    });
    expect(reqHead.method).toBe("HEAD");
    expect(reqHead.body).toBeNull();
  });

  it("filters out undefined and null searchParams while preserving falsy 0 and false", () => {
    const req = createMockRequest("/api/filter", {
      searchParams: {
        validZero: 0,
        validFalse: false,
        validStr: "hello",
        skipUndefined: undefined,
        skipNull: null,
      },
    });
    const url = new URL(req.url);
    expect(url.searchParams.get("validZero")).toBe("0");
    expect(url.searchParams.get("validFalse")).toBe("false");
    expect(url.searchParams.get("validStr")).toBe("hello");
    expect(url.searchParams.has("skipUndefined")).toBe(false);
    expect(url.searchParams.has("skipNull")).toBe(false);
  });
});
