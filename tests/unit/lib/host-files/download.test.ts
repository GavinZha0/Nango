import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { downloadToPath, type DownloadRequest, type DownloadKernelResult } from "@/lib/host-files/download.server";

const fetchMock = vi.fn();

let dir: string;
let absPath: string;

beforeEach(async () => {
  // A shared mock fn across tests: call counts and queued replies would
  // otherwise leak from one case into the next.
  fetchMock.mockReset();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  vi.stubGlobal("fetch", fetchMock);
  dir = await mkdtemp(path.join(tmpdir(), "nango-download-"));
  absPath = path.join(dir, "payload.dsc");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function errorCode(result: DownloadKernelResult): string {
  return result.ok ? "ok" : result.error;
}

/**
 * A real web ReadableStream behind a real Response, so the kernel's
 * pipeline, backpressure, and abort handling run exactly as in production.
 */
function response(opts: {
  chunks?: string[];
  status?: number;
  headers?: Record<string, string>;
  chunkDelayMs?: number;
  /** Hang after the first chunk so the deadline has to fire. */
  stallAfterFirst?: boolean;
} = {}) {
  const chunks = (opts.chunks ?? ["hello"]).map((c) => new TextEncoder().encode(c));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < chunks.length; i += 1) {
        controller.enqueue(chunks[i]!);
        if (i === 0 && opts.stallAfterFirst) {
          await new Promise((r) => setTimeout(r, 5_000));
          return;
        }
        if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: opts.status ?? 200,
    headers: opts.headers ?? { "content-type": "text/plain" },
  });
}

function req(overrides: Partial<DownloadRequest> = {}): DownloadRequest {
  return {
    url: "https://example.com/payload.dsc",
    absPath,
    maxBytes: 1_000,
    timeoutMs: 5_000,
    maxRedirects: 5,
    allowPrivate: false,
    ...overrides,
  };
}

async function assertNothingSaved(): Promise<void> {
  await expect(readFile(absPath, "utf8")).rejects.toBeTruthy();
  const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
  expect(leftovers).toEqual([]);
}

describe("downloadToPath — success", () => {
  it("writes the streamed bytes and returns no body", async () => {
    fetchMock.mockResolvedValue(response({ chunks: ["abc", "def"] }));

    const out = await downloadToPath(req());

    expect(out).toEqual({ ok: true, sizeBytes: 6, contentType: "text/plain" });
    expect(await readFile(absPath, "utf8")).toBe("abcdef");
  });

  it("asks for identity encoding and handles redirects itself", async () => {
    fetchMock.mockResolvedValue(response({ chunks: ["raw"] }));
    await downloadToPath(req());

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    // A transparently gzipped body would land labelled .dsc and never open.
    expect((init.headers as Record<string, string>)["accept-encoding"]).toBe("identity");
    expect(init.redirect).toBe("manual");
  });

  it("replaces an existing target atomically", async () => {
    await writeFile(absPath, "old content that is longer");
    fetchMock.mockResolvedValue(response({ chunks: ["new"] }));

    expect((await downloadToPath(req())).ok).toBe(true);
    expect(await readFile(absPath, "utf8")).toBe("new");
    expect((await readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

describe("downloadToPath — byte budget", () => {
  it("refuses a declared Content-Length above the budget before touching fs", async () => {
    fetchMock.mockResolvedValue(
      response({ chunks: ["whatever"], headers: { "content-length": "99999" } }),
    );

    expect(errorCode(await downloadToPath(req({ maxBytes: 100 })))).toBe("TOO_LARGE");
    await assertNothingSaved();
  });

  it("counts the stream when the declared length lies", async () => {
    // Content-Length says 5; the body ships 500 bytes.
    fetchMock.mockResolvedValue(
      response({
        chunks: Array.from({ length: 5 }, () => "x".repeat(100)),
        headers: { "content-length": "5" },
      }),
    );

    const out = await downloadToPath(req({ maxBytes: 250 }));

    expect(errorCode(out)).toBe("TOO_LARGE");
    if (!out.ok) expect(out.message).toMatch(/Nothing was saved/);
    await assertNothingSaved();
  });
});

describe("downloadToPath — deadline", () => {
  it("aborts a stalled body and leaves nothing behind", async () => {
    fetchMock.mockResolvedValue(response({ chunks: ["first", "never"], stallAfterFirst: true }));

    expect(errorCode(await downloadToPath(req({ timeoutMs: 30 })))).toBe("TIMEOUT");
    await assertNothingSaved();
  });

  it("survives a slow but progressing transfer inside the deadline", async () => {
    fetchMock.mockResolvedValue(response({ chunks: ["ab", "cd"], chunkDelayMs: 10 }));

    expect((await downloadToPath(req({ timeoutMs: 2_000 }))).ok).toBe(true);
  });
});

describe("downloadToPath — address guard per hop", () => {
  it("refuses a plain http URL without a request", async () => {
    expect(errorCode(await downloadToPath(req({ url: "http://example.com/x.dsc" })))).toBe("BAD_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows a relative Location to the resolved URL", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: 302, headers: { location: "/mirror/payload.dsc" } }))
      .mockResolvedValueOnce(response({ chunks: ["moved"] }));

    expect((await downloadToPath(req())).ok).toBe(true);
    expect(await readFile(absPath, "utf8")).toBe("moved");
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://example.com/mirror/payload.dsc");
  });

  it("blocks a redirect that lands on a metadata address", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ status: 301, headers: { location: "https://169.254.169.254/latest/meta-data" } }),
    );

    expect(errorCode(await downloadToPath(req()))).toBe("SSRF_BLOCKED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await assertNothingSaved();
  });

  it("blocks a redirect whose host resolves privately", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ status: 302, headers: { location: "https://internal.example/x.dsc" } }),
    );
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    expect(errorCode(await downloadToPath(req()))).toBe("SSRF_BLOCKED");
  });

  it("honours the operator escape hatch on a later hop", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: 302, headers: { location: "https://127.0.0.1/x.dsc" } }))
      .mockResolvedValueOnce(response({ chunks: ["lan"] }));

    expect((await downloadToPath(req({ allowPrivate: true }))).ok).toBe(true);
  });

  it("stops at max_redirects rather than looping", async () => {
    fetchMock.mockResolvedValue(response({ status: 307, headers: { location: "/loop" } }));

    expect(errorCode(await downloadToPath(req({ maxRedirects: 2 })))).toBe("BAD_URL");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a redirect with no Location", async () => {
    fetchMock.mockResolvedValue(response({ status: 302, headers: {} }));

    expect(errorCode(await downloadToPath(req()))).toBe("HTTP_STATUS");
  });
});

describe("downloadToPath — failures", () => {
  it("never saves an error page", async () => {
    fetchMock.mockResolvedValue(
      response({
        chunks: ["<html>404 not found</html>"],
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    );

    const out = await downloadToPath(req());

    expect(errorCode(out)).toBe("HTTP_STATUS");
    if (!out.ok) expect(out.message).toMatch(/Nothing was saved/);
    await assertNothingSaved();
  });

  it("reports an unreachable origin as NET_FAILED", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }));

    expect(errorCode(await downloadToPath(req()))).toBe("NET_FAILED");
  });

  it("reports an unwritable destination as WRITE_FAILED", async () => {
    fetchMock.mockResolvedValue(response({ chunks: ["data"] }));

    const out = await downloadToPath(req({ absPath: path.join(dir, "missing-parent", "x.dsc") }));

    expect(errorCode(out)).toBe("WRITE_FAILED");
  });
});
