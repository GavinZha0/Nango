import { describe, it, expect } from "vitest";

import {
  SshBasicAuthPayload,
  SshPrivateKeyPayload,
} from "@/lib/ssh/credential-schema";

describe("SshBasicAuthPayload (basic_auth shape)", () => {
  it("accepts {username, password}", () => {
    const result = SshBasicAuthPayload.safeParse({
      username: "deploy",
      password: "hunter2",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty username", () => {
    expect(
      SshBasicAuthPayload.safeParse({ username: "", password: "p" }).success,
    ).toBe(false);
  });

  it("rejects empty password", () => {
    expect(
      SshBasicAuthPayload.safeParse({ username: "deploy", password: "" })
        .success,
    ).toBe(false);
  });

  it("rejects payload missing username (was acceptable in V1)", () => {
    expect(SshBasicAuthPayload.safeParse({ password: "p" }).success).toBe(false);
  });
});

describe("SshPrivateKeyPayload (private_key shape)", () => {
  const PEM =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

  it("accepts {username, privateKey}", () => {
    expect(
      SshPrivateKeyPayload.safeParse({ username: "deploy", privateKey: PEM })
        .success,
    ).toBe(true);
  });

  it("accepts optional passphrase", () => {
    expect(
      SshPrivateKeyPayload.safeParse({
        username: "deploy",
        privateKey: PEM,
        passphrase: "s",
      }).success,
    ).toBe(true);
  });

  it("rejects empty privateKey", () => {
    expect(
      SshPrivateKeyPayload.safeParse({ username: "deploy", privateKey: "" })
        .success,
    ).toBe(false);
  });

  it("rejects payload missing username", () => {
    expect(
      SshPrivateKeyPayload.safeParse({ privateKey: PEM }).success,
    ).toBe(false);
  });
});
