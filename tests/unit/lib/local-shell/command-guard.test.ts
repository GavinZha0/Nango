import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkSensitiveCommand,
  validateLocalShellCwd,
} from "@/lib/local-shell/command-guard.server";

describe("local-shell command guard", () => {
  it("blocks reading .env files while allowing template files", () => {
    expect(checkSensitiveCommand("cat .env").allowed).toBe(false);
    expect(checkSensitiveCommand("Get-Content .env.local").allowed).toBe(false);
    expect(checkSensitiveCommand("type C:\\app\\.env.production").allowed).toBe(false);
    expect(checkSensitiveCommand("grep KEY ./.env").allowed).toBe(false);

    expect(checkSensitiveCommand("cat .env.example").allowed).toBe(true);
    expect(checkSensitiveCommand("cat .env.sample").allowed).toBe(true);
    expect(checkSensitiveCommand("cat .env.template").allowed).toBe(true);
    expect(checkSensitiveCommand("git status").allowed).toBe(true);
  });

  it("blocks Nango secret files, host credentials, and OS env bypasses", () => {
    expect(checkSensitiveCommand("cat secrets.bin").allowed).toBe(false);
    expect(checkSensitiveCommand("cat ~/.ssh/id_rsa").allowed).toBe(false);
    expect(checkSensitiveCommand("cat ~/.aws/credentials").allowed).toBe(false);
    expect(checkSensitiveCommand("cat /proc/self/environ").allowed).toBe(false);
    expect(
      checkSensitiveCommand(
        "[System.Environment]::GetEnvironmentVariable('OPENAI_API_KEY', 'User')",
      ).allowed,
    ).toBe(false);
    expect(
      checkSensitiveCommand("Get-ItemProperty HKCU:\\Environment").allowed,
    ).toBe(false);
    expect(
      checkSensitiveCommand("reg query HKCU\\Environment").allowed,
    ).toBe(false);
    expect(checkSensitiveCommand("echo $env:OPENAI_API_KEY").allowed).toBe(false);
    expect(checkSensitiveCommand("echo $OPENAI_API_KEY").allowed).toBe(false);
    expect(checkSensitiveCommand("echo %OPENAI_API_KEY%").allowed).toBe(false);
  });
});

describe("local-shell cwd validation", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("defaults to host.file.root and resolves relative paths inside it", async () => {
    const root = await makeTempDir("nango-shell-root-");
    const sub = path.join(root, "proj");
    await fs.mkdir(sub);

    const def = await validateLocalShellCwd(undefined, {
      hostFileRoot: root,
      allowAnyCwd: false,
      desktopUserDataDir: null,
      appRootDir: null,
    });
    expect(def.ok).toBe(true);

    const rel = await validateLocalShellCwd("proj", {
      hostFileRoot: root,
      allowAnyCwd: false,
      desktopUserDataDir: null,
      appRootDir: null,
    });
    expect(rel.ok).toBe(true);
    if (rel.ok) {
      expect(rel.cwd.toLowerCase()).toBe((await fs.realpath(sub)).toLowerCase());
    }
  });

  it("refuses cwd outside host.file.root when allowAnyCwd is false", async () => {
    const root = await makeTempDir("nango-shell-root-");
    const other = await makeTempDir("nango-shell-other-");

    const res = await validateLocalShellCwd(other, {
      hostFileRoot: root,
      allowAnyCwd: false,
      desktopUserDataDir: null,
      appRootDir: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("INVALID_CWD");
  });

  it("always blocks Nango userData directory and app root even when allowAnyCwd is true", async () => {
    const root = await makeTempDir("nango-shell-root-");
    const userData = await makeTempDir("nango-shell-userdata-");
    const appRoot = await makeTempDir("nango-shell-approot-");
    const pgData = path.join(userData, "pgdata");
    await fs.mkdir(pgData);

    const blockedUserData = await validateLocalShellCwd(pgData, {
      hostFileRoot: root,
      allowAnyCwd: true,
      desktopUserDataDir: userData,
      appRootDir: appRoot,
    });
    expect(blockedUserData.ok).toBe(false);
    if (!blockedUserData.ok) {
      expect(blockedUserData.error).toBe("SENSITIVE_ACCESS_DENIED");
      expect(blockedUserData.rule).toBe("NANGO_USER_DATA_DIR");
    }

    const blockedAppRoot = await validateLocalShellCwd(appRoot, {
      hostFileRoot: root,
      allowAnyCwd: true,
      desktopUserDataDir: userData,
      appRootDir: appRoot,
    });
    expect(blockedAppRoot.ok).toBe(false);
    if (!blockedAppRoot.ok) {
      expect(blockedAppRoot.error).toBe("SENSITIVE_ACCESS_DENIED");
      expect(blockedAppRoot.rule).toBe("NANGO_APP_ROOT");
    }
  });
});
