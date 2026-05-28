import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/config", () => ({
  // Mirror real defaults so the test exercises the production path.
  getConfig: (_key: string, defaultValue: string) => defaultValue,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
}));

const { tavilyProvider } = await import("@/lib/web-search/tavily.server");
const { ProviderHttpError } = await import("@/lib/web-search/errors");

interface TavilyResultStub {
  title?: string | null;
  url?: string | null;
  content?: string | null;
  published_date?: string | null;
  favicon?: string | null;
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

describe("tavilyProvider.search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalises a successful Tavily response", async () => {
    const stub: TavilyResultStub[] = [
      {
        title: "Tavily-style article",
        url: "https://example.com/article",
        content: "Concise, query-relevant excerpt from the page.",
        favicon: "https://example.com/favicon.ico",
      },
      {
        title: "Other article",
        url: "https://other.example/page",
        content: "Another excerpt.",
        // No favicon — Tavily occasionally omits.
      },
    ];
    mockFetchOnce(200, { results: stub });

    const results = await tavilyProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "tvly-k", restUrl: null },
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Tavily-style article",
      url: "https://example.com/article",
      snippet: "Concise, query-relevant excerpt from the page.",
      favicon: "https://example.com/favicon.ico",
    });
    expect(results[1].title).toBe("Other article");
    expect(results[1].snippet).toBe("Another excerpt.");
    expect(results[1].favicon).toBeUndefined();
    // Tavily never produces a per-result `image`; this is the
    // documented difference from Exa and the card_list UI falls
    // back to favicon → letter-avatar.
    expect(results[0].image).toBeUndefined();
    expect(results[1].image).toBeUndefined();
  });

  it("forwards published_date as publishedAt when present (news topic)", async () => {
    mockFetchOnce(200, {
      results: [
        {
          title: "News item",
          url: "https://news.example/",
          content: "Breaking news excerpt.",
          published_date: "2025-04-01",
        },
      ],
    });
    const results = await tavilyProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "tvly-k", restUrl: null },
    );
    expect(results[0].publishedAt).toBe("2025-04-01");
  });

  it("drops results without a URL", async () => {
    mockFetchOnce(200, {
      results: [
        { title: "no url", url: null, content: "x" },
        { title: "ok", url: "https://ok.example/", content: "y" },
      ],
    });
    const results = await tavilyProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://ok.example/");
  });

  it("honours topK as an upper bound", async () => {
    const many: TavilyResultStub[] = Array.from({ length: 10 }, (_, i) => ({
      title: `r${i}`,
      url: `https://e.example/${i}`,
      content: `body ${i}`,
    }));
    mockFetchOnce(200, { results: many });
    const results = await tavilyProvider.search(
      { query: "q", topK: 3, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toHaveLength(3);
  });

  it("uses Bearer auth and strips trailing slashes from restUrl override", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ results: [] }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await tavilyProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "tvly-secret", restUrl: "https://proxy.example/tavily///" },
    );

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://proxy.example/tavily/search",
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tvly-secret",
    );
  });

  it("sends the canonical request body (max_results, search_depth, include_favicon)", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ results: [] }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await tavilyProvider.search(
      { query: "openai latest news", topK: 5, signal: new AbortController().signal },
      { apiKey: "tvly-k", restUrl: null },
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody.query).toBe("openai latest news");
    expect(sentBody.max_results).toBe(5);
    expect(sentBody.search_depth).toBe("basic");
    expect(sentBody.include_favicon).toBe(true);
    expect(sentBody.include_answer).toBe(false);
    expect(sentBody.include_raw_content).toBe(false);
    expect(sentBody.include_images).toBe(false);
    // No api_key in body — we authenticate via Authorization header.
    expect(sentBody.api_key).toBeUndefined();
  });

  it("throws ProviderHttpError tagged with provider='tavily' on non-2xx", async () => {
    mockFetchOnce(401, "Invalid API key");
    try {
      await tavilyProvider.search(
        { query: "q", topK: 1, signal: new AbortController().signal },
        { apiKey: "bad", restUrl: null },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderHttpError);
      const e = err as InstanceType<typeof ProviderHttpError>;
      expect(e.provider).toBe("tavily");
      expect(e.status).toBe(401);
      expect(e.body).toContain("Invalid API key");
    }
  });

  it("returns [] when Tavily returns no results array", async () => {
    mockFetchOnce(200, { foo: "bar" });
    const results = await tavilyProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toEqual([]);
  });

  it("truncates long content to the snippet cap (500)", async () => {
    const long = "x".repeat(5000);
    mockFetchOnce(200, {
      results: [{ title: "t", url: "https://example.com/", content: long }],
    });
    const results = await tavilyProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results[0].snippet.length).toBeLessThanOrEqual(500);
    expect(results[0].snippet.endsWith("…")).toBe(true);
  });
});
