import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { configValues } = vi.hoisted(() => ({
  configValues: new Map<string, string>(),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfig: (key: string, defaultValue: string) =>
      configValues.get(key) ?? defaultValue,
    getConfigNumber: (key: string, defaultValue: number) => {
      const raw = configValues.get(key);
      return raw === undefined ? defaultValue : Number(raw);
    },
    getConfigBoolean: (key: string, defaultValue: boolean) => {
      const raw = configValues.get(key);
      return raw === undefined ? defaultValue : raw === "true";
    },
  };
});

const { searxngProvider } = await import("@/lib/web-search/searxng.server");
const { ProviderNetworkError } = await import("@/lib/web-search/errors");

interface SearxngResultStub {
  title?: string | null;
  url?: string | null;
  content?: string | null;
  publishedDate?: string | null;
  thumbnail?: string | null;
  img_src?: string | null;
}

function mockFetchOnce(
  status: number,
  body: unknown,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      } as unknown as Response;
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function search(apiKey: string, restUrl: string | null = "http://searxng:8080") {
  return searxngProvider.search(
    { query: "test query", topK: 5, signal: new AbortController().signal },
    { apiKey, restUrl },
  );
}

describe("searxngProvider.search", () => {
  beforeEach(() => {
    configValues.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps SearXNG fields onto the shared result shape", async () => {
    const stub: SearxngResultStub[] = [
      {
        title: "Result 1",
        url: "https://a.example/1",
        content: "<b>Hello</b>\n\n  world",
        publishedDate: "2026-01-02T00:00:00",
        thumbnail: "https://img.example/a.jpg",
      },
      {
        title: "",
        url: "https://b.example/2",
        content: "Second",
      },
      {
        title: "Duplicate URL",
        url: "https://a.example/1",
        content: "duplicate",
      },
      {
        title: "Unsafe scheme",
        url: "javascript:alert(1)",
        content: "nope",
      },
    ];
    mockFetchOnce(200, { results: stub });

    const results = await search("none");

    expect(results).toEqual([
      {
        title: "Result 1",
        url: "https://a.example/1",
        snippet: "Hello world",
        publishedAt: "2026-01-02T00:00:00",
      },
      {
        title: "https://b.example/2",
        url: "https://b.example/2",
        snippet: "Second",
      },
    ]);
  });

  it("sends q, format=json, and config-driven params", async () => {
    const fetchMock = mockFetchOnce(200, { results: [] });

    await search("none");

    const rawUrl = fetchMock.mock.calls[0][0] as URL;
    expect(rawUrl.pathname).toBe("/search");
    expect(rawUrl.searchParams.get("q")).toBe("test query");
    expect(rawUrl.searchParams.get("format")).toBe("json");
    expect(rawUrl.searchParams.get("categories")).toBe("general");
    expect(rawUrl.searchParams.get("safesearch")).toBe("0");
    // Empty language means "use the instance default" — omit it.
    expect(rawUrl.searchParams.get("language")).toBeNull();
  });

  it("does not send an Authorization header for anonymous placeholders", async () => {
    const fetchMock = mockFetchOnce(200, { results: [] });

    await search("none");
    await search("empty");
    await search("anonymous");

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    }
  });

  it("forwards a real key as a Bearer token (reverse-proxy deployments)", async () => {
    const fetchMock = mockFetchOnce(200, { results: [] });

    await search("proxy-secret");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer proxy-secret",
    );
  });

  it("omits thumbnails by default but forwards them when enabled", async () => {
    const body = {
      results: [
        {
          title: "With thumb",
          url: "https://example.com/a",
          content: "x",
          thumbnail: "https://cdn.example/a.jpg",
        },
      ],
    };

    mockFetchOnce(200, body);
    const withoutThumbs = await search("none");
    expect(withoutThumbs[0].image).toBeUndefined();

    configValues.set("web_search.searxng.include_thumbnails", "true");
    mockFetchOnce(200, body);
    const withThumbs = await search("none");
    expect(withThumbs[0].image).toBe("https://cdn.example/a.jpg");
  });

  it("honours topK as an upper bound", async () => {
    const stub = Array.from({ length: 5 }, (_, i) => ({
      title: `r${i}`,
      url: `https://example.com/${i}`,
      content: `snippet ${i}`,
    }));
    mockFetchOnce(200, { results: stub });

    const results = await searxngProvider.search(
      { query: "q", topK: 2, signal: new AbortController().signal },
      { apiKey: "none", restUrl: "http://searxng:8080" },
    );
    expect(results).toHaveLength(2);
  });

  it("rejects when the credential has no Base URL", async () => {
    await expect(search("none", null)).rejects.toThrow(/missing its Base URL/);
  });

  it("wraps fetch failures in ProviderNetworkError with deployment guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("getaddrinfo ENOTFOUND searxng"),
        });
      }),
    );

    const err = await search("none", "http://searxng:8080").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ProviderNetworkError);
    const networkErr = err as InstanceType<typeof ProviderNetworkError>;
    expect(networkErr.url).toBe("http://searxng:8080");
    expect(networkErr.detail).toContain("ENOTFOUND");
    expect(networkErr.message).toContain("127.0.0.1:8680");
  });

  it("rethrows AbortError so the runtime classifies it as a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );

    await expect(search("none")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("maps 403 to a ProviderHttpError with a JSON-format hint", async () => {
    mockFetchOnce(403, "Forbidden");

    await expect(search("none")).rejects.toMatchObject({
      name: "ProviderHttpError",
      provider: "searxng",
      status: 403,
      hint: expect.stringContaining("search.formats"),
    });
  });

  it("rejects a non-JSON response with an actionable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
          text: async () => "<html></html>",
        } as unknown as Response;
      }),
    );

    await expect(search("none")).rejects.toThrow(/non-JSON/);
  });

  it("requires a results array", async () => {
    mockFetchOnce(200, { answers: [] });
    await expect(search("none")).rejects.toThrow(/results array/);
  });

  it("exports a display name for the outcome card", () => {
    expect(searxngProvider.displayName).toBe("SearXNG");
    expect(searxngProvider.id).toBe("searxng");
  });
});
