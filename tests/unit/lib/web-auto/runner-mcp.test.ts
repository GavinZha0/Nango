import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockBorrow = vi.fn();
const mockRelease = vi.fn();

vi.mock("@/lib/mcp", () => ({
  mcpProviderPool: {
    borrow: (...args: unknown[]) => mockBorrow(...args),
    release: (...args: unknown[]) => mockRelease(...args),
  },
}));

vi.mock("@/lib/agent-pipeline/compose", () => ({
  composePipelinedMcpProvider: (p: unknown) => p,
}));

vi.mock("@/lib/agent-pipeline/middlewares", () => ({
  toolErrorHandlingMiddleware: () => () => {},
}));

const { parsePlaywrightOutput, runWebAutoMcp } = await import(
  "@/lib/web-auto/runner-mcp"
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parsePlaywrightOutput", () => {
  it("extracts clean JSON result and page metadata from markdown sections", () => {
    const raw = {
      content: [
        {
          type: "text",
          text: `### Result
\`\`\`json
{
  "saved": true,
  "id": "123"
}
\`\`\`
### Ran Playwright code
\`\`\`javascript
await page.click('button');
\`\`\`
### Page
- Page URL: https://example.com/checkout
- Page Title: Checkout Page
- Console: [info] Loaded
### Events
- click
`,
        },
      ],
    };

    const parsed = parsePlaywrightOutput(raw) as {
      result: { saved: boolean; id: string };
      page?: { url?: string; title?: string; console?: string };
    };

    expect(parsed.result).toEqual({ saved: true, id: "123" });
    expect(parsed.page).toEqual({
      url: "https://example.com/checkout",
      title: "Checkout Page",
      console: "[info] Loaded",
    });
  });

  it("handles non-JSON result string inside ### Result section", () => {
    const raw = {
      content: [
        {
          type: "text",
          text: "### Result\nPlain text output\n### Page\n- Page URL: https://example.com",
        },
      ],
    };

    const parsed = parsePlaywrightOutput(raw) as {
      result: string;
      page?: { url?: string };
    };

    expect(parsed.result).toBe("Plain text output");
    expect(parsed.page?.url).toBe("https://example.com");
  });

  it("falls back to direct JSON parsing for raw json text", () => {
    const raw = '{"status": "ok"}';
    const parsed = parsePlaywrightOutput(raw);
    expect(parsed).toEqual({ result: { status: "ok" } });
  });
});

describe("runWebAutoMcp", () => {
  it("returns errored when mcpProviderPool fails to borrow provider", async () => {
    mockBorrow.mockRejectedValueOnce(new Error("Connection refused"));

    const outcome = await runWebAutoMcp({
      mcpServerId: "server-1",
      scriptContent: "console.log('hi');",
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.error).toBeDefined();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("returns errored when browser_run_code_unsafe tool is missing on server", async () => {
    const mockProvider = {
      tools: vi.fn().mockResolvedValue({
        other_tool: { execute: vi.fn() },
      }),
    };
    mockBorrow.mockResolvedValueOnce(mockProvider);

    const outcome = await runWebAutoMcp({
      mcpServerId: "server-1",
      scriptContent: "console.log('hi');",
    });

    expect(outcome.status).toBe("errored");
    expect(outcome.error?.message).toContain("Playwright tool not found");
    expect(mockRelease).toHaveBeenCalledWith("server-1", mockProvider);
  });

  it("returns failed when tool returns MCP error result (isError: true with content)", async () => {
    const mockTool = {
      execute: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "Target element not found" }],
      }),
    };
    const mockProvider = {
      tools: vi.fn().mockResolvedValue({
        browser_run_code_unsafe: mockTool,
      }),
    };
    mockBorrow.mockResolvedValueOnce(mockProvider);

    const outcome = await runWebAutoMcp({
      mcpServerId: "server-1",
      scriptContent: "await page.click('#missing');",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.source).toBe("upstream");
    expect(outcome.error?.message).toBe("Target element not found");
    expect(mockRelease).toHaveBeenCalledWith("server-1", mockProvider);
  });

  it("returns success and parses structured output on successful tool execution", async () => {
    const mockTool = {
      execute: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: "### Result\n```json\n{\"ok\": true}\n```\n### Page\n- Page URL: https://example.com\n- Page Title: Example",
          },
        ],
      }),
    };
    const mockProvider = {
      tools: vi.fn().mockResolvedValue({
        browser_run_code_unsafe: mockTool,
      }),
    };
    mockBorrow.mockResolvedValueOnce(mockProvider);

    const outcome = await runWebAutoMcp({
      mcpServerId: "server-1",
      scriptContent: "return { ok: true };",
    });

    expect(outcome.status).toBe("success");
    expect(outcome.error).toBeNull();
    expect(outcome.executionOutput).toEqual({
      result: { ok: true },
      page: {
        url: "https://example.com",
        title: "Example",
        console: undefined,
      },
    });
    expect(mockRelease).toHaveBeenCalledWith("server-1", mockProvider);
  });
});