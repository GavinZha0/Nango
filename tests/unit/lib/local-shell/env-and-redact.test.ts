import { describe, expect, it } from "vitest";

import {
  buildSafeLocalEnv,
  collectParentSensitiveValues,
  isForbiddenEnvKey,
  parseEnvPassthroughKeys,
} from "@/lib/local-shell/env.server";
import { redactShellOutput } from "@/lib/local-shell/redact.server";

describe("local-shell env allowlist", () => {
  it("strips host secrets and Nango internal secrets by default", () => {
    const sourceEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/alice",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "sk-secret-openai-key-12345678901234567890",
      ANTHROPIC_API_KEY: "sk-ant-secret-key-12345678901234567890",
      CREDENTIAL_ENCRYPTION_KEYRING: "k1=0123456789abcdef",
      BETTER_AUTH_SECRET: "super-secret-better-auth-token",
      POSTGRES_PASSWORD: "super-secret-db-password",
      AWS_SECRET_ACCESS_KEY: "aws-secret-value-12345",
      GITHUB_TOKEN: "ghp_1234567890abcdefghij1234567890",
      CUSTOM_UNLISTED: "not-in-allowlist",
    };

    const env = buildSafeLocalEnv({
      sourceEnv,
      platform: "linux",
      passthroughRaw: "",
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/alice");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CREDENTIAL_ENCRYPTION_KEYRING).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CUSTOM_UNLISTED).toBeUndefined();
  });

  it("allows non-sensitive env_passthrough keys while refusing secret keys", () => {
    const keys = parseEnvPassthroughKeys(
      "HTTP_PROXY, KUBECONFIG, OPENAI_API_KEY, MY_API_TOKEN, POSTGRES_PASSWORD, NANGO_SECRET",
    );
    expect(keys).toEqual(["HTTP_PROXY", "KUBECONFIG"]);

    const env = buildSafeLocalEnv({
      sourceEnv: {
        PATH: "/usr/bin",
        HTTP_PROXY: "http://127.0.0.1:7890",
        KUBECONFIG: "/home/alice/.kube/config",
        OPENAI_API_KEY: "sk-should-never-pass",
      },
      platform: "linux",
      passthroughRaw: "HTTP_PROXY,KUBECONFIG,OPENAI_API_KEY",
    });

    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.KUBECONFIG).toBe("/home/alice/.kube/config");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("prepends NANGO_BUNDLED_NODE_BIN_DIR to PATH", () => {
    const env = buildSafeLocalEnv({
      sourceEnv: {
        Path: "C:\\Windows\\System32",
        NANGO_BUNDLED_NODE_BIN_DIR: "C:\\Program Files\\Nango\\resources\\node",
      },
      platform: "win32",
      passthroughRaw: "",
    });

    expect(env.Path).toBe(
      "C:\\Program Files\\Nango\\resources\\node;C:\\Windows\\System32",
    );
  });

  it("classifies sensitive env keys accurately", () => {
    expect(isForbiddenEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isForbiddenEnvKey("DATABASE_URL")).toBe(true);
    expect(isForbiddenEnvKey("NANGO_DESKTOP")).toBe(true);
    expect(isForbiddenEnvKey("CUSTOM_AUTH_TOKEN")).toBe(true);
    expect(isForbiddenEnvKey("PATH")).toBe(false);
    expect(isForbiddenEnvKey("HTTP_PROXY")).toBe(false);
    expect(isForbiddenEnvKey("KUBECONFIG")).toBe(false);
  });

  it("collects parent sensitive values longest-first for output redaction", () => {
    const values = collectParentSensitiveValues({
      PATH: "/usr/bin",
      SHORT_KEY: "1234",
      OPENAI_API_KEY: "secret-alpha-12345",
      BETTER_AUTH_SECRET: "secret-beta-1234567890",
    });
    expect(values).toEqual(["secret-beta-1234567890", "secret-alpha-12345"]);
  });
});

describe("local-shell output redaction", () => {
  it("redacts API keys, tokens, PEM blocks, dotenv assignments, and exact parent secrets", () => {
    const input = [
      "openai: sk-proj-abcdefghijklmnopqrstuvwx",
      "anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwx",
      "github: ghp_1234567890abcdefghij1234567890",
      "dotenv: MY_API_KEY=supersecretvalue999",
      "parent: custom-parent-secret-xyz",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "git commit by alice@example.com at 1732750000",
    ].join("\n");

    const redacted = redactShellOutput(input, {
      sourceEnv: {
        CUSTOM_SECRET: "custom-parent-secret-xyz",
      },
    });

    expect(redacted).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx");
    expect(redacted).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwx");
    expect(redacted).not.toContain("ghp_1234567890abcdefghij1234567890");
    expect(redacted).not.toContain("supersecretvalue999");
    expect(redacted).not.toContain("custom-parent-secret-xyz");
    expect(redacted).not.toContain("MIIEpAIBAAKCAQEA");
    expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
    // Normal git emails and Unix timestamps are preserved
    expect(redacted).toContain("alice@example.com");
    expect(redacted).toContain("1732750000");
  });
});
