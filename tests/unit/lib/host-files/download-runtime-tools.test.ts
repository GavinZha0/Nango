import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig: Record<string, string> = {};
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfig: (key: string, defaultValue: string) => mockConfig[key] ?? defaultValue,
    getConfigNumber: (key: string, defaultValue: number) => {
      const raw = mockConfig[key];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    },
    getConfigBoolean: (key: string, defaultValue: boolean) => {
      const raw = mockConfig[key];
      return raw === undefined ? defaultValue : raw === "true";
    },
    getConfigMs: (key: string, defaultSeconds: number) => {
      const raw = mockConfig[key];
      const seconds = raw === undefined ? defaultSeconds : Number(raw);
      return (Number.isFinite(seconds) ? seconds : defaultSeconds) * 1000;
    },
  };
});

// The kernel has its own suite (download.test.ts). Here it is a seam: the
// gates must run before it, so a refusal asserts it was never reached.
const { kernelMock } = vi.hoisted(() => ({ kernelMock: vi.fn() }));
vi.mock("@/lib/host-files/download.server", () => ({ downloadToPath: kernelMock }));

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { buildDownloadFileTool } from "@/lib/host-files/download-runtime-tools";
import type { DownloadEnvelope } from "@/lib/host-files/schema";

let sandbox: string;
let root: string;
const tool = buildDownloadFileTool();

async function download(args: {
  url: string;
  target_path: string;
  overwrite?: boolean;
}): Promise<DownloadEnvelope> {
  return (await tool.execute!(args)) as DownloadEnvelope;
}

/** The kernel's side of a success: the bytes land, and only then. */
async function kernelWrites({ absPath }: { absPath: string }): Promise<DownloadKernelShape> {
  await writeFile(absPath, "real bytes from the wire");
  return { ok: true, sizeBytes: 24, contentType: "text/plain" };
}

interface DownloadKernelShape {
  ok: true;
  sizeBytes: number;
  contentType: string | null;
}

beforeEach(async () => {
  Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
  kernelMock.mockReset();
  kernelMock.mockImplementation(kernelWrites as never);
  const created = await mkdtemp(path.join(tmpdir(), "nango-download-tool-"));
  sandbox = await realpath(created);
  root = path.join(sandbox, "root");
  await mkdir(root, { recursive: true });
  mockConfig["host.file.root"] = root;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(sandbox, { recursive: true, force: true });
});

describe("download_file — gates before the network", () => {
  it("refuses when no shared folder is mounted", async () => {
    mockConfig["host.file.root"] = "";
    const res = await download({ url: "https://example.com/a.txt", target_path: "a.txt" });
    expect(!res.ok && res.error === "ROOT_NOT_CONFIGURED").toBe(true);
    expect(kernelMock).not.toHaveBeenCalled();
  });

  it("refuses a non-https URL without a request", async () => {
    const plain = await download({ url: "http://example.com/a.txt", target_path: "a.txt" });
    expect(!plain.ok && plain.error === "BAD_URL").toBe(true);

    const relative = await download({ url: "example.com/a.txt", target_path: "a.txt" });
    expect(!relative.ok && relative.error === "BAD_URL").toBe(true);

    expect(kernelMock).not.toHaveBeenCalled();
  });

  it("refuses an escaping destination", async () => {
    const res = await download({ url: "https://example.com/a.txt", target_path: "../outside/a.txt" });
    expect(!res.ok).toBe(true);
    if (!res.ok) expect(["PATH_ESCAPE", "NOT_FOUND"]).toContain(res.error);
    expect(kernelMock).not.toHaveBeenCalled();
  });

  it("names create_folder when the parent directory is missing", async () => {
    const res = await download({
      url: "https://example.com/x.txt",
      target_path: "inbox/debian/x.txt",
    });
    expect(!res.ok && res.error === "NOT_FOUND").toBe(true);
    if (!res.ok) expect(res.message).toMatch(/create_folder/);
    expect(kernelMock).not.toHaveBeenCalled();
  });

  it("refuses a dot-prefixed path", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });

    for (const target of [".env", "notes/.hidden.md"]) {
      const res = await download({ url: "https://example.com/x.txt", target_path: target });
      expect(!res.ok && res.error === "PATH_ESCAPE").toBe(true);
    }

    // A dot directory that does not exist yet is refused a step earlier,
    // by the containment check. Either way the answer arrives before the
    // first packet — which is the property that matters.
    const nested = await download({ url: "https://example.com/x.txt", target_path: "a/.git/c.txt" });
    expect(!nested.ok).toBe(true);
    if (!nested.ok) expect(["PATH_ESCAPE", "NOT_FOUND"]).toContain(nested.error);

    expect(kernelMock).not.toHaveBeenCalled();
  });

  it("refuses a destination type that is not allowlisted", async () => {
    const res = await download({
      url: "https://example.com/payload",
      target_path: "payload.tar.gz",
    });
    expect(!res.ok && res.error === "TYPE_DENIED").toBe(true);
    // CONTRACT: the guard is on the destination name, and the message
    // closes the "just rename it" door.
    if (!res.ok) expect(res.message).toMatch(/[Rr]enaming/);
    expect(kernelMock).not.toHaveBeenCalled();
  });

  it("refuses a directory target", async () => {
    // The extension gate is a pure string check and runs first, so a
    // directory only reaches the lstat when its name looks like a file.
    await mkdir(path.join(root, "notes.txt"), { recursive: true });
    const res = await download({ url: "https://example.com/x.txt", target_path: "notes.txt" });
    expect(!res.ok && res.error === "IS_DIRECTORY").toBe(true);
    expect(kernelMock).not.toHaveBeenCalled();

    const plainDir = await download({ url: "https://example.com/x.txt", target_path: "folder" });
    expect(!plainDir.ok && plainDir.error === "TYPE_DENIED").toBe(true);
  });

  it("refuses an existing target unless overwrite is passed", async () => {
    await writeFile(path.join(root, "keep.txt"), "the user's own bytes");

    const res = await download({ url: "https://example.com/x.txt", target_path: "keep.txt" });
    expect(!res.ok && res.error === "EXISTS").toBe(true);
    expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("the user's own bytes");
    expect(kernelMock).not.toHaveBeenCalled();

    const forced = await download({
      url: "https://example.com/x.txt",
      target_path: "keep.txt",
      overwrite: true,
    });
    expect(forced.ok).toBe(true);
    expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("real bytes from the wire");
  });
});

describe("download_file — allowlist is operator config", () => {
  it("honours a widened list", async () => {
    mockConfig["download.allowed_extensions"] = "iso, tar.gz , .IMG";

    const iso = await download({ url: "https://example.com/x", target_path: "disk.iso" });
    expect(iso.ok).toBe(true);

    // Whole-name matching, so an admin listing `tar.gz` gets exactly that.
    const twin = await download({ url: "https://example.com/x", target_path: "a.tar.gz" });
    expect(twin.ok).toBe(true);

    const bareGz = await download({ url: "https://example.com/x", target_path: "b.gz" });
    expect(!bareGz.ok && bareGz.error === "TYPE_DENIED").toBe(true);

    // Case of the destination never matters.
    const upper = await download({ url: "https://example.com/x", target_path: "CAM.IMG" });
    expect(upper.ok).toBe(true);

    // And the default types are gone once the operator replaces the list.
    const txt = await download({ url: "https://example.com/x", target_path: "notes.txt" });
    expect(!txt.ok && txt.error === "TYPE_DENIED").toBe(true);
  });

  it("accepts the reference target from the brief", async () => {
    await mkdir(path.join(root, "inbox", "debian"), { recursive: true });

    const res = await download({
      url: "https://ftp.debian.org/debian/pool/main/d/db5.3/db5.3_5.3.28+dfsg2-9.dsc",
      target_path: "inbox/debian/db5.3_5.3.28+dfsg2-9.dsc",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("inbox/debian/db5.3_5.3.28+dfsg2-9.dsc");
  });
});

describe("download_file — result shape", () => {
  it("returns no bytes", async () => {
    const res = await download({ url: "https://example.com/a.txt", target_path: "a.txt" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // CONTRACT: exactly these four keys — a `content`/`body` field would
      // put the file into the conversation.
      expect(Object.keys(res).sort()).toEqual(["contentType", "ok", "path", "sizeBytes"]);
      expect(res.path).toBe("a.txt");
      expect(res.sizeBytes).toBe(24);
    }
  });

  it("passes the config budgets and the jailed path to the kernel", async () => {
    mockConfig["download.max_bytes"] = "123";
    mockConfig["download.timeout"] = "7";
    mockConfig["download.max_redirects"] = "1";
    mockConfig["download.allow_private_network"] = "true";
    await mkdir(path.join(root, "deep"), { recursive: true });

    const res = await download({ url: "https://example.com/a.txt", target_path: "deep/a.txt" });

    expect(res.ok).toBe(true);
    const arg = kernelMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.url).toBe("https://example.com/a.txt");
    expect(arg.absPath).toBe(path.join(root, "deep", "a.txt"));
    expect(arg.maxBytes).toBe(123);
    // Seconds on the config side, ms at the socket.
    expect(arg.timeoutMs).toBe(7000);
    expect(arg.maxRedirects).toBe(1);
    expect(arg.allowPrivate).toBe(true);
  });

  it("surfaces a kernel refusal unchanged", async () => {
    kernelMock.mockResolvedValue({
      ok: false,
      error: "SSRF_BLOCKED",
      message: "that host is not public",
    } as never);

    const res = await download({
      url: "https://metadata.example/latest",
      target_path: "a.txt",
    });
    expect(!res.ok && res.error === "SSRF_BLOCKED").toBe(true);
    if (!res.ok) expect(res.message).toBe("that host is not public");
  });
});
