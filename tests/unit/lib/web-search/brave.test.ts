import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/config", () => ({
  // Mirror real defaults so the test exercises the production path.
  getConfig: (_key: string, defaultValue: string) => defaultValue,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
}));

const { braveProvider } = await import("@/lib/web-search/brave.server");
const { ProviderHttpError } = await import("@/lib/web-search/errors");

interface BraveResultStub {
  title?: string | null;
  url?: string | null;
  description?: string | null;
  page_age?: string | null;
  meta_url?: { favicon?: string | null } | null;
  thumbnail?: { src?: string | null; original?: string | null } | null;
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

describe("braveProvider.search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads results from data.web.results (Brave's nested shape)", async () => {
    const stub: BraveResultStub[] = [
      {
        title: "Brave result 1",
        url: "https://example.com/a",
        description: "First description.",
        page_age: "2025-04-01T10:00:00Z",
        meta_url: { favicon: "https://example.com/favicon.ico" },
        thumbnail: { src: "https://cdn.example/thumb-a.jpg" },
      },
      {
        title: "Brave result 2",
        url: "https://other.example/b",
        description: "Second description.",
        // No page_age, no thumbnail, no favicon — exercises the
        // optional-field branches.
      },
    ];
    mockFetchOnce(200, { web: { results: stub } });

    const results = await braveProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "BSA-key", restUrl: null },
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Brave result 1",
      url: "https://example.com/a",
      snippet: "First description.",
      publishedAt: "2025-04-01T10:00:00Z",
      image: "https://cdn.example/thumb-a.jpg",
      favicon: "https://example.com/favicon.ico",
    });
    // Second result has no optional fields — they stay undefined,
    // never null (matches the WebSearchResult contract).
    expect(results[1]).toEqual({
      title: "Brave result 2",
      url: "https://other.example/b",
      snippet: "Second description.",
    });
  });

  it("returns [] when the response has no `web` key (mixed-mode-only response)", async () => {
    // Brave occasionally returns ONLY news / videos / etc. with no
    // `web` key on niche queries. Treat as zero web results, not an
    // error.
    mockFetchOnce(200, { news: { results: [] }, query: { original: "q" } });
    const results = await braveProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toEqual([]);
  });

  it("drops results without a URL", async () => {
    mockFetchOnce(200, {
      web: {
        results: [
          { title: "no url", url: null, description: "x" },
          { title: "ok", url: "https://ok.example/", description: "y" },
        ],
      },
    });
    const results = await braveProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://ok.example/");
  });

  it("honours topK as an upper bound", async () => {
    const many: BraveResultStub[] = Array.from({ length: 10 }, (_, i) => ({
      title: `r${i}`,
      url: `https://e.example/${i}`,
      description: `body ${i}`,
    }));
    mockFetchOnce(200, { web: { results: many } });
    const results = await braveProvider.search(
      { query: "q", topK: 3, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toHaveLength(3);
  });

  it("uses X-Subscription-Token auth header (NOT Authorization Bearer)", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [] } }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await braveProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "BSA-my-secret", restUrl: null },
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("BSA-my-secret");
    expect(headers.Authorization).toBeUndefined();
  });

  it("issues a GET request with query params (q, count, country, search_lang)", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [] } }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await braveProvider.search(
      { query: "openai latest news", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );

    const callUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(callUrl.origin + callUrl.pathname).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
    expect(callUrl.searchParams.get("q")).toBe("openai latest news");
    expect(callUrl.searchParams.get("count")).toBe("5");
    expect(callUrl.searchParams.get("country")).toBe("us");
    expect(callUrl.searchParams.get("search_lang")).toBe("en");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("GET");
    // No body on GET.
    expect(init.body).toBeUndefined();
  });

  it("strips trailing slashes from restUrl override", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [] } }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await braveProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: "https://proxy.example/brave///" },
    );

    const callUrl = String(fetchMock.mock.calls[0][0]);
    expect(callUrl.startsWith("https://proxy.example/brave/res/v1/web/search?")).toBe(
      true,
    );
  });

  it("encodes non-ASCII queries (Chinese)", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [] } }),
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await braveProvider.search(
      { query: "硅谷新闻", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );

    const callUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(callUrl.searchParams.get("q")).toBe("硅谷新闻");
  });

  it("throws ProviderHttpError tagged with provider='brave' on non-2xx", async () => {
    mockFetchOnce(401, "Invalid subscription token");
    try {
      await braveProvider.search(
        { query: "q", topK: 1, signal: new AbortController().signal },
        { apiKey: "bad", restUrl: null },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderHttpError);
      const e = err as InstanceType<typeof ProviderHttpError>;
      expect(e.provider).toBe("brave");
      expect(e.status).toBe(401);
      expect(e.body).toContain("Invalid subscription token");
    }
  });

  it("truncates long descriptions to the snippet cap (500)", async () => {
    const long = "x".repeat(5000);
    mockFetchOnce(200, {
      web: {
        results: [{ title: "t", url: "https://example.com/", description: long }],
      },
    });
    const results = await braveProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results[0].snippet.length).toBeLessThanOrEqual(500);
    expect(results[0].snippet.endsWith("…")).toBe(true);
  });
});
