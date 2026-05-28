import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/config", () => ({
  // Mirror real defaults so the test exercises the production path.
  getConfig: (_key: string, defaultValue: string) => defaultValue,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
}));

const { jinaProvider } = await import("@/lib/web-search/jina.server");
const { ProviderHttpError } = await import("@/lib/web-search/errors");

interface JinaResultStub {
  title?: string | null;
  url?: string | null;
  description?: string | null;
  content?: string | null;
  publishedTime?: string | null;
}

function mockFetchOnce(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      } as unknown as Response;
    }),
  );
}

describe("jinaProvider.search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalises Jina's { data: [...] } response", async () => {
    const stub: JinaResultStub[] = [
      {
        title: "Jina result 1",
        url: "https://example.com/a",
        description: "Short SERP description.",
        content: "Much longer Markdown content extracted from the page…",
        publishedTime: "2025-04-01T10:00:00Z",
      },
      {
        title: "Jina result 2",
        url: "https://other.example/b",
        // Empty description — falls back to content.
        description: "",
        content: "Fallback content excerpt.",
      },
    ];
    mockFetchOnce(200, { code: 200, data: stub });

    const results = await jinaProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "jina-key", restUrl: null },
    );

    expect(results).toHaveLength(2);
    // First: description preferred over content.
    expect(results[0]).toEqual({
      title: "Jina result 1",
      url: "https://example.com/a",
      snippet: "Short SERP description.",
      publishedAt: "2025-04-01T10:00:00Z",
    });
    // Second: description empty, content used.
    expect(results[1].snippet).toBe("Fallback content excerpt.");
    expect(results[1].publishedAt).toBeUndefined();
    // No per-result image / favicon from Jina's default response.
    expect(results[0].image).toBeUndefined();
    expect(results[0].favicon).toBeUndefined();
  });

  it("sends Bearer auth, Accept JSON, and X-Engine: direct (the new default)", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ code: 200, data: [] }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await jinaProvider.search(
      { query: "openai latest news", topK: 1, signal: new AbortController().signal },
      { apiKey: "jina-secret", restUrl: null },
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jina-secret");
    expect(headers.accept).toBe("application/json");
    // Default engine is now `direct` — faster SERP-only mode that
    // avoids Jina's per-page content extraction and the timeouts
    // it produced against the 10s runtime tool budget. Operators
    // who want the slower content-extraction mode opt back in via
    // `web_search.jina.engine=default`.
    expect(headers["X-Engine"]).toBe("direct");
    expect(init.method).toBe("GET");
  });

  it("encodes the query into the URL path (non-ASCII safe)", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ code: 200, data: [] }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await jinaProvider.search(
      { query: "硅谷 AI 新闻", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );

    const callUrl = String(fetchMock.mock.calls[0][0]);
    // encodeURIComponent percent-encodes the Chinese chars + space.
    expect(callUrl).toBe(
      "https://s.jina.ai/" + encodeURIComponent("硅谷 AI 新闻"),
    );
  });

  it("omits Authorization header when apiKey is empty (anonymous)", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ code: 200, data: [] }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await jinaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "", restUrl: null },
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("strips trailing slashes from restUrl override", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ code: 200, data: [] }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await jinaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: "https://proxy.example/jina///" },
    );

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://proxy.example/jina/q",
    );
  });

  it("drops results without a URL", async () => {
    mockFetchOnce(200, {
      data: [
        { title: "no url", url: null, content: "x" },
        { title: "ok", url: "https://ok.example/", content: "y" },
      ],
    });
    const results = await jinaProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://ok.example/");
  });

  it("honours topK as an upper bound", async () => {
    const many: JinaResultStub[] = Array.from({ length: 10 }, (_, i) => ({
      title: `r${i}`,
      url: `https://e.example/${i}`,
      content: `body ${i}`,
    }));
    mockFetchOnce(200, { data: many });
    const results = await jinaProvider.search(
      { query: "q", topK: 3, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toHaveLength(3);
  });

  it("throws ProviderHttpError tagged with provider='jina' on non-2xx", async () => {
    mockFetchOnce(429, "Too Many Requests");
    try {
      await jinaProvider.search(
        { query: "q", topK: 1, signal: new AbortController().signal },
        { apiKey: "k", restUrl: null },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderHttpError);
      const e = err as InstanceType<typeof ProviderHttpError>;
      expect(e.provider).toBe("jina");
      expect(e.status).toBe(429);
      expect(e.body).toContain("Too Many Requests");
    }
  });

  it("returns [] when Jina returns no data array", async () => {
    mockFetchOnce(200, { code: 200, status: 20000 });
    const results = await jinaProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toEqual([]);
  });

  it("truncates long content snippets to the cap (500)", async () => {
    const long = "x".repeat(5000);
    mockFetchOnce(200, {
      data: [
        {
          title: "t",
          url: "https://example.com/",
          // description empty so content is used
          description: "",
          content: long,
        },
      ],
    });
    const results = await jinaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results[0].snippet.length).toBeLessThanOrEqual(500);
    expect(results[0].snippet.endsWith("…")).toBe(true);
  });
});
