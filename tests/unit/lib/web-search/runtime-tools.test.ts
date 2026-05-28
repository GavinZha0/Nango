import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/config", () => ({
  getConfig: (_key: string, defaultValue: string) => defaultValue,
  getConfigMs: (_key: string, defaultSeconds: number) => defaultSeconds * 1000,
  getConfigNumber: (_key: string, defaultValue: number) => defaultValue,
}));

// Resolver mock — the runtime tool consults this; we'll swap per-test.
const resolveSearchCredential = vi.fn();
vi.mock("@/lib/web-search/lookup.server", () => ({
  resolveSearchCredential,
  // Re-export keeps the import surface valid even if other tests import it.
  isWebSearchProvider: (v: string) =>
    ["exa", "tavily", "brave", "jina"].includes(v),
}));

const { buildWebSearchTool } = await import("@/lib/web-search/runtime-tools");
const registry = await import("@/lib/web-search/registry.server");
const { NotImplementedError } = await import("@/lib/web-search/errors");

interface ExecuteCtx { abortSignal?: AbortSignal }
interface WebSearchOk {
  ok: true;
  provider: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}
interface WebSearchErr { ok: false; error: string; message: string }
type Envelope = WebSearchOk | WebSearchErr;

function buildToolWithFetch(fetchImpl: typeof fetch): ReturnType<typeof buildWebSearchTool> {
  vi.stubGlobal("fetch", fetchImpl);
  return buildWebSearchTool();
}

describe("buildWebSearchTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns NO_PROVIDER when the resolver finds nothing", async () => {
    resolveSearchCredential.mockResolvedValue({
      ok: false,
      error: "NO_PROVIDER",
      message: "no creds",
    });
    const tool = buildWebSearchTool();
    const exec = tool.execute as (args: unknown, ctx?: ExecuteCtx) => Promise<Envelope>;
    const out = await exec({ query: "q", topK: 5 });
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error).toBe("NO_PROVIDER");
    }
  });

  it("calls Exa and returns ok envelope with provider tag", async () => {
    resolveSearchCredential.mockResolvedValue({
      ok: true,
      resolved: {
        credentialId: "cred-1",
        provider: "exa",
        apiKey: "k",
        restUrl: null,
      },
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: "hello", url: "https://hello.example/", text: "world" },
        ],
      }),
      text: async () => "",
    }) as unknown as Response);

    const tool = buildToolWithFetch(fetchMock);
    const exec = tool.execute as (args: unknown, ctx?: ExecuteCtx) => Promise<Envelope>;
    const out = await exec({ query: "hi", topK: 3 });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.provider).toBe("exa");
      expect(out.results[0].url).toBe("https://hello.example/");
      expect(out.results[0].snippet).toBe("world");
    }
  });

  it("maps Exa 5xx into UPSTREAM_HTTP envelope", async () => {
    resolveSearchCredential.mockResolvedValue({
      ok: true,
      resolved: { credentialId: "c", provider: "exa", apiKey: "k", restUrl: null },
    });
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "service down",
    }) as unknown as Response);

    const tool = buildToolWithFetch(fetchMock);
    const exec = tool.execute as (args: unknown, ctx?: ExecuteCtx) => Promise<Envelope>;
    const out = await exec({ query: "q", topK: 1 });
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error).toBe("UPSTREAM_HTTP");
      expect(out.message).toMatch(/503/);
    }
  });

  it("maps provider NotImplementedError into NOT_IMPLEMENTED envelope", async () => {
    // No provider is a stub in production any more (Exa, Tavily,
    // Brave all wired), but the mapping code path is preserved for
    // FUTURE stub providers. We exercise it here by spying on
    // getWebSearchProvider and returning a synthetic provider that
    // throws NotImplementedError — verifies the runtime tool's
    // error-mapping branch without depending on real upstream HTTP.
    const spy = vi.spyOn(registry, "getWebSearchProvider").mockReturnValue({
      id: "brave",
      displayName: "Brave (synthetic stub)",
      search: vi.fn(async () => {
        throw new NotImplementedError("brave");
      }),
    });
    try {
      resolveSearchCredential.mockResolvedValue({
        ok: true,
        resolved: { credentialId: "c", provider: "brave", apiKey: "k", restUrl: null },
      });
      const tool = buildWebSearchTool();
      const exec = tool.execute as (args: unknown, ctx?: ExecuteCtx) => Promise<Envelope>;
      const out = await exec({ query: "q", topK: 1 });
      expect(out.ok).toBe(false);
      if (out.ok === false) {
        expect(out.error).toBe("NOT_IMPLEMENTED");
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("maps AbortError into UPSTREAM_TIMEOUT", async () => {
    resolveSearchCredential.mockResolvedValue({
      ok: true,
      resolved: { credentialId: "c", provider: "exa", apiKey: "k", restUrl: null },
    });
    const fetchMock = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const tool = buildToolWithFetch(fetchMock as unknown as typeof fetch);
    const exec = tool.execute as (args: unknown, ctx?: ExecuteCtx) => Promise<Envelope>;
    const out = await exec({ query: "q", topK: 1 });
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error).toBe("UPSTREAM_TIMEOUT");
    }
  });

  it("maps generic upstream parse errors into INVALID_RESPONSE", async () => {
    resolveSearchCredential.mockResolvedValue({
      ok: true,
      resolved: { credentialId: "c", provider: "exa", apiKey: "k", restUrl: null },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("malformed json");
      },
      text: async () => "",
    }) as unknown as Response);
    const tool = buildToolWithFetch(fetchMock);
    const exec = tool.execute as (args: unknown, ctx?: ExecuteCtx) => Promise<Envelope>;
    const out = await exec({ query: "q", topK: 1 });
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error).toBe("INVALID_RESPONSE");
    }
  });
});
