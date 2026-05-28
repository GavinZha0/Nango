import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { evaluateCommandPolicy } = await import("@/lib/ssh/policy");

describe("evaluateCommandPolicy — unconstrained", () => {
  it("allows any command when allow=null and deny=[]", () => {
    expect(evaluateCommandPolicy("rm -rf /", null, []).allowed).toBe(true);
    expect(evaluateCommandPolicy("ls", null, []).allowed).toBe(true);
  });
});

describe("evaluateCommandPolicy — denylist", () => {
  it("rejects on first matching deny pattern", () => {
    const r = evaluateCommandPolicy("rm -rf /tmp", null, ["^rm", "shutdown"]);
    expect(r.allowed).toBe(false);
    expect(r.matchedPattern).toBe("^rm");
  });

  it("ignores non-matching deny patterns", () => {
    expect(
      evaluateCommandPolicy("ls -la", null, ["^rm", "shutdown"]).allowed,
    ).toBe(true);
  });

  it("matches deny anywhere in the command (no anchor)", () => {
    const r = evaluateCommandPolicy("sudo rm -rf .", null, ["rm"]);
    expect(r.allowed).toBe(false);
  });
});

describe("evaluateCommandPolicy — allowlist", () => {
  it("allows when command matches one allow pattern", () => {
    expect(
      evaluateCommandPolicy("ls -la", ["^ls", "^cat"], []).allowed,
    ).toBe(true);
    expect(
      evaluateCommandPolicy("cat /var/log/syslog", ["^ls", "^cat"], [])
        .allowed,
    ).toBe(true);
  });

  it("rejects when command matches no allow pattern", () => {
    const r = evaluateCommandPolicy("tail -f log", ["^ls", "^cat"], []);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/did not match/i);
  });

  it("treats empty allowlist as deny-all (paranoid mode)", () => {
    const r = evaluateCommandPolicy("ls", [], []);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/empty allowlist/i);
  });
});

describe("evaluateCommandPolicy — deny precedence", () => {
  it("deny wins even when allow also matches", () => {
    const r = evaluateCommandPolicy(
      "rm /tmp/x",
      ["^rm", "^ls"],
      ["^rm"],
    );
    expect(r.allowed).toBe(false);
    expect(r.matchedPattern).toBe("^rm");
  });
});

describe("evaluateCommandPolicy — fail-closed on bad regex", () => {
  it("rejects when an allow pattern fails to compile", () => {
    const r = evaluateCommandPolicy("ls", ["[unclosed"], []);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/invalid regex/i);
  });

  it("rejects when a deny pattern fails to compile", () => {
    const r = evaluateCommandPolicy("ls", null, ["[unclosed"]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/invalid regex/i);
  });

  it("does not fall through to 'allowed' on compile failure", () => {
    // Even if the candidate command would have matched a valid allow
    // pattern, a compile error in any pattern (allow or deny) must
    // produce a rejection — never a default-allow.
    const r = evaluateCommandPolicy("ls", ["^ls"], ["[unclosed"]);
    expect(r.allowed).toBe(false);
  });
});
