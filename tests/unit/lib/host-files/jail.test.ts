import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockRoot = "";
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfig: (key: string, defaultValue: string) =>
      key === "host.file.root" ? mockRoot : defaultValue,
  };
});

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { getHostFileRoot, isWithin, resolveInJail } from "@/lib/host-files/jail.server";

let sandbox: string;
let root: string;

beforeEach(async () => {
  const created = await mkdtemp(path.join(tmpdir(), "nango-jail-"));
  // realpath so the macOS /tmp → /private/tmp swap cannot make the
  // containment assertions disagree with the filesystem's view.
  sandbox = await realpath(created);
  root = path.join(sandbox, "root");
  await mkdir(root, { recursive: true });
  mockRoot = root;
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("getHostFileRoot", () => {
  it("treats an unset or blank root as feature-off", () => {
    mockRoot = "";
    expect(getHostFileRoot()).toBeNull();
    mockRoot = "   ";
    expect(getHostFileRoot()).toBeNull();
  });

  it("returns the configured root verbatim", () => {
    expect(getHostFileRoot()).toBe(root);
  });
});

describe("resolveInJail — containment", () => {
  it("resolves a root-relative path inside the jail", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes", "todo.md"), "hi");

    const res = await resolveInJail(root, "notes/todo.md", "read");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.absPath).toBe(path.join(root, "notes", "todo.md"));
      expect(res.relPath).toBe(path.join("notes", "todo.md").split(path.sep).join("/"));
    }
  });

  it("maps a bare '/' to the root itself", async () => {
    const res = await resolveInJail(root, "/", "read");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.relPath).toBe("");
  });

  it("refuses a traversal that reaches an outside directory", async () => {
    const outside = path.join(sandbox, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "top secret");

    const res = await resolveInJail(root, `../outside/secret.txt`, "read");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("PATH_ESCAPE");
  });

  it("neutralizes a POSIX absolute path into the root instead of escaping", async () => {
    await writeFile(path.join(root, "secret.txt"), "inside");

    const res = await resolveInJail(root, "/secret.txt", "read");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.relPath).toBe("secret.txt");
      expect(isWithin(root, res.absPath)).toBe(true);
    }
  });

  it("neutralizes a drive-prefixed path the same way", async () => {
    // The remainder after the drive spec must not re-root the join.
    const res = await resolveInJail(root, "C:/Windows/win.ini", "write");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("NOT_FOUND");
      expect(res.message).toMatch(/parent directory/);
    }
  });

  it("reports a missing parent distinctly from an escape", async () => {
    const res = await resolveInJail(root, "nope/deeper/file.md", "write");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("NOT_FOUND");
  });

  it("rejects NUL bytes and blank input", async () => {
    const nul = await resolveInJail(root, "a\0b.md", "read");
    expect(!nul.ok && nul.error === "INVALID_PATH").toBe(true);

    const blank = await resolveInJail(root, "   ", "read");
    expect(!blank.ok && blank.error === "INVALID_PATH").toBe(true);
  });

  it("fails loudly when the configured root itself is gone", async () => {
    const missing = path.join(sandbox, "does-not-exist");
    const res = await resolveInJail(missing, "a.md", "read");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("ROOT_NOT_CONFIGURED");
  });
});

describe("resolveInJail — symlinks", () => {
  /** Windows refuses symlink creation without developer mode; the tests
   *  then step over the assertion rather than failing the suite. */
  async function symlinkOrSkip(target: string, linkPath: string): Promise<boolean> {
    try {
      await symlink(target, linkPath);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "EPERM") return false;
      throw e;
    }
  }

  it("refuses a symlinked leaf", async () => {
    await writeFile(path.join(sandbox, "outside-target.txt"), "leak");
    if (!(await symlinkOrSkip(path.join(sandbox, "outside-target.txt"), path.join(root, "link.txt")))) return;

    const res = await resolveInJail(root, "link.txt", "read");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("PATH_ESCAPE");
      expect(res.message).toMatch(/symlink/);
    }
  });

  it("refuses a write whose leaf is a dangling link to an outside path", async () => {
    // The leaf does not exist, so a naive resolve-then-write would follow
    // the link and create the file OUTSIDE the jail.
    if (!(await symlinkOrSkip(path.join(sandbox, "not-here-yet"), path.join(root, "dangling")))) return;

    const res = await resolveInJail(root, "dangling", "write");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("PATH_ESCAPE");
  });

  it("catches an intermediate directory that links outside", async () => {
    const outside = path.join(sandbox, "outside-dir");
    await mkdir(outside, { recursive: true });
    if (!(await symlinkOrSkip(outside, path.join(root, "linkdir")))) return;

    const res = await resolveInJail(root, "linkdir/new-file.md", "write");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("PATH_ESCAPE");
  });
});

describe("isWithin", () => {
  it("accepts the parent itself and descendants", () => {
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, path.join(root, "a"))).toBe(true);
    expect(isWithin(root, path.join(root, "a", "b", "c.txt"))).toBe(true);
  });

  it("rejects a sibling sharing the root's name as a prefix", () => {
    // Without the trailing separator this passes a "/mnt/root" vs
    // "/mnt/root-evil" check.
    expect(isWithin(root, `${root}-evil`)).toBe(false);
    expect(isWithin(root, path.join(sandbox, "other"))).toBe(false);
  });
});
