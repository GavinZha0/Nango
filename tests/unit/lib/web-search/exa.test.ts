import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/config", () => ({
  // Mirror real defaults so the test exercises the production path.
  getConfig: (_key: string, defaultValue: string) => defaultValue,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
}));

const { exaProvider, ExaHttpError } = await import("@/lib/web-search/exa.server");

interface ExaResultStub {
  title?: string | null;
  url?: string | null;
  publishedDate?: string | null;
  text?: string | null;
  image?: string | null;
  favicon?: string | null;
  highlights?: string[] | null;
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

describe("exaProvider.search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalises successful Exa response into WebSearchResult[]", async () => {
    const stub: ExaResultStub[] = [
      {
        title: "TypeScript 5.5 announcement",
        url: "https://example.com/ts5.5",
        publishedDate: "2025-04-01",
        text: "TypeScript 5.5 introduces inferred type predicates …",
      },
      {
        title: "AG-UI overview",
        url: "https://ag-ui.com/",
        publishedDate: null,
        text: null,
        highlights: ["AG-UI is the agent-user-interaction protocol"],
      },
    ];
    mockFetchOnce(200, { results: stub });

    const controller = new AbortController();
    const results = await exaProvider.search(
      { query: "ts 5.5 release", topK: 5, signal: controller.signal },
      { apiKey: "k", restUrl: null },
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "TypeScript 5.5 announcement",
      url: "https://example.com/ts5.5",
      snippet: "TypeScript 5.5 introduces inferred type predicates …",
      publishedAt: "2025-04-01",
    });
    expect(results[1].title).toBe("AG-UI overview");
    expect(results[1].url).toBe("https://ag-ui.com/");
    expect(results[1].snippet).toBe("AG-UI is the agent-user-interaction protocol");
    expect(results[1].publishedAt).toBeUndefined();
    // Neither stub supplied image / favicon — fields stay omitted
    // (NOT nulled — the WebSearchResult contract is "absent means absent").
    expect(results[0].image).toBeUndefined();
    expect(results[0].favicon).toBeUndefined();
    expect(results[1].image).toBeUndefined();
    expect(results[1].favicon).toBeUndefined();
  });

  it("forwards image and favicon when Exa returns them", async () => {
    mockFetchOnce(200, {
      results: [
        {
          title: "Hero image article",
          url: "https://news.example/article-1",
          text: "Body excerpt …",
          image: "https://cdn.example/og/article-1.jpg",
          favicon: "https://news.example/favicon.ico",
        },
      ],
    });
    const results = await exaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results[0].image).toBe("https://cdn.example/og/article-1.jpg");
    expect(results[0].favicon).toBe("https://news.example/favicon.ico");
  });

  it("treats empty-string image/favicon as absent", async () => {
    mockFetchOnce(200, {
      results: [
        { title: "t", url: "https://example.com/", text: "x", image: "", favicon: "" },
      ],
    });
    const results = await exaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results[0].image).toBeUndefined();
    expect(results[0].favicon).toBeUndefined();
  });

  it("drops results without a URL", async () => {
    mockFetchOnce(200, {
      results: [
        { title: "no url here", url: null, text: "irrelevant" },
        { title: "ok", url: "https://ok.example/", text: "fine" },
      ],
    });
    const results = await exaProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://ok.example/");
  });

  it("honours topK as an upper bound", async () => {
    const many: ExaResultStub[] = Array.from({ length: 10 }, (_, i) => ({
      title: `r${i}`,
      url: `https://e.example/${i}`,
      text: `body ${i}`,
    }));
    mockFetchOnce(200, { results: many });
    const results = await exaProvider.search(
      { query: "q", topK: 3, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toHaveLength(3);
  });

  it("uses restUrl override when provided", async () => {
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

    await exaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "secret", restUrl: "https://proxy.example/exa" },
    );

    const callUrl = String(fetchMock.mock.calls[0][0]);
    expect(callUrl).toBe("https://proxy.example/exa/search");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("secret");
  });

  it("strips trailing slashes from restUrl override", async () => {
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

    await exaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "secret", restUrl: "https://proxy.example/exa///" },
    );

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://proxy.example/exa/search");
  });

  it("throws ExaHttpError on non-2xx upstream", async () => {
    mockFetchOnce(401, "Invalid API key");
    await expect(
      exaProvider.search(
        { query: "q", topK: 1, signal: new AbortController().signal },
        { apiKey: "bad", restUrl: null },
      ),
    ).rejects.toBeInstanceOf(ExaHttpError);
  });

  it("captures status + body on ExaHttpError", async () => {
    mockFetchOnce(500, "upstream meltdown");
    try {
      await exaProvider.search(
        { query: "q", topK: 1, signal: new AbortController().signal },
        { apiKey: "k", restUrl: null },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExaHttpError);
      const e = err as InstanceType<typeof ExaHttpError>;
      expect(e.status).toBe(500);
      expect(e.body).toContain("upstream meltdown");
    }
  });

  it("returns [] when Exa returns no results array", async () => {
    mockFetchOnce(200, { foo: "bar" });
    const results = await exaProvider.search(
      { query: "q", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results).toEqual([]);
  });

  it("truncates very long text excerpts to the max snippet length", async () => {
    // Cap is 500 chars by default (since switching the primary
    // snippet source to Exa's `summary`) — feed something well past it.
    const longText = "x".repeat(5000);
    mockFetchOnce(200, {
      results: [{ title: "t", url: "https://example.com/", text: longText }],
    });
    const results = await exaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results[0].snippet.length).toBeLessThanOrEqual(500);
    expect(results[0].snippet.endsWith("…")).toBe(true);
  });

  it("forwards the LLM summary as snippet when Exa returns one", async () => {
    mockFetchOnce(200, {
      results: [
        {
          title: "Article",
          url: "https://news.example/",
          // Exa returns BOTH summary and text; summary should win.
          summary: "Exa's pre-summarised, query-aware blurb.",
          text:
            "A much longer raw page excerpt. The LLM should not see " +
            "this when summary is present, because summary is more " +
            "concise and already query-aware.",
        },
      ],
    });
    const results = await exaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results[0].snippet).toBe(
      "Exa's pre-summarised, query-aware blurb.",
    );
  });

  it("falls back to text when summary is absent", async () => {
    mockFetchOnce(200, {
      results: [
        {
          title: "Article",
          url: "https://news.example/",
          // No summary (paywalled / robots-blocked / similar Exa edge case).
          text: "Raw text excerpt only.",
        },
      ],
    });
    const results = await exaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results[0].snippet).toBe("Raw text excerpt only.");
  });

  it("falls back to highlights[0] when both summary and text are absent", async () => {
    mockFetchOnce(200, {
      results: [
        {
          title: "Article",
          url: "https://news.example/",
          highlights: ["First highlight sentence."],
        },
      ],
    });
    const results = await exaProvider.search(
      { query: "q", topK: 1, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );
    expect(results[0].snippet).toBe("First highlight sentence.");
  });

  it("sends summary, livecrawl, and capped text maxCharacters in the request body", async () => {
    // Capture the request body via vi.fn<typeof fetch> — the same
    // typed-mock idiom used elsewhere in this file. Defending against
    // Exa-side knob drift, not against Exa's API behaviour.
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

    await exaProvider.search(
      { query: "openai latest news", topK: 5, signal: new AbortController().signal },
      { apiKey: "k", restUrl: null },
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sentBody = JSON.parse(String(init.body));
    // Primary snippet source: per-result LLM summary, query-aware.
    expect(sentBody.contents.summary).toEqual({ query: "openai latest news" });
    // Fallback snippet source: still requested + locally capped at 500.
    expect(sentBody.contents.text.maxCharacters).toBe(500);
    // Freshness knob.
    expect(sentBody.contents.livecrawl).toBe("preferred");
    // Shape stuff.
    expect(sentBody.type).toBe("auto");
    expect(sentBody.numResults).toBe(5);
  });
});
