import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PostgresSecretsSchema } from "@/lib/data-sources/postgres/adapter";
import { MysqlSecretsSchema } from "@/lib/data-sources/mysql/adapter";
import { MariadbSecretsSchema } from "@/lib/data-sources/mariadb/adapter";
import { VerticaSecretsSchema } from "@/lib/data-sources/vertica/adapter";
import type { ResolvedDataSource } from "@/lib/data-sources/types";

// Phase D-2.2 split: secrets schemas are now identical across all
// four database providers — they hold ONLY auth (username + password).
// Connection metadata (host / port / database / params) lives on the
// data_source row and is exercised in adapter / runtime tests.
//
// D-2.5: standardised on `username` (matches the admin
// CredentialFormDialog basic_auth payload). Each adapter maps
// `username` → its driver-native key at connection-build time.

describe("Database secret schemas (post-D-2.5 username)", () => {
  it("PostgresSecretsSchema accepts {username, password}", () => {
    const r = PostgresSecretsSchema.parse({ username: "svc", password: "secret" });
    expect(r.username).toBe("svc");
    expect(r.password).toBe("secret");
  });

  it("password defaults to empty string when omitted", () => {
    const r = PostgresSecretsSchema.parse({ username: "svc" });
    expect(r.password).toBe("");
  });

  it("rejects missing username", () => {
    expect(() => PostgresSecretsSchema.parse({ password: "x" })).toThrow();
  });

  it("rejects empty username", () => {
    expect(() => PostgresSecretsSchema.parse({ username: "", password: "x" })).toThrow();
  });

  it("MysqlSecretsSchema accepts the same {username, password} shape", () => {
    const r = MysqlSecretsSchema.parse({ username: "svc", password: "x" });
    expect(r).toEqual({ username: "svc", password: "x" });
  });

  it("MariadbSecretsSchema is identical to MysqlSecretsSchema", () => {
    expect(MariadbSecretsSchema).toBe(MysqlSecretsSchema);
  });

  it("VerticaSecretsSchema accepts {username, password}", () => {
    const r = VerticaSecretsSchema.parse({ username: "v_user", password: "v_pw" });
    expect(r).toEqual({ username: "v_user", password: "v_pw" });
  });
});

describe("MySQL attach-string builder (D-2.2 ResolvedDataSource input)", () => {
  it("formats expected key=value pairs from a resolved data source", async () => {
    const { buildMysqlAttachString } = await import(
      "@/lib/data-sources/mysql/extract.server"
    );
    const resolved: ResolvedDataSource = {
      id: "ds-1",
      name: "warehouse",
      provider: "mysql",
      host: "10.0.0.5",
      port: 3307,
      database: "warehouse",
      params: { ssl_mode: "required", charset: "utf8mb4" },
      username: "svc",
      password: "p@ss",
      policy: { readOnly: true, tableAllowlist: null, tableDenylist: [] },
    };
    const s = buildMysqlAttachString(resolved);
    expect(s).toContain("host=10.0.0.5");
    expect(s).toContain("port=3307");
    // Adapter maps `username` → driver-native `user=` key.
    expect(s).toContain("user=svc");
    expect(s).toContain("password=p@ss");
    expect(s).toContain("database=warehouse");
    expect(s).toContain("ssl_mode=required");
    // Pass-through param survives.
    expect(s).toContain("charset=utf8mb4");
  });

  it("falls back to ssl_mode=preferred when admin omits it", async () => {
    const { buildMysqlAttachString } = await import(
      "@/lib/data-sources/mysql/extract.server"
    );
    const resolved: ResolvedDataSource = {
      id: "ds-2",
      name: "stage",
      provider: "mysql",
      host: "h",
      port: 3306,
      database: "d",
      params: {},
      username: "u",
      password: "p",
      policy: { readOnly: true, tableAllowlist: null, tableDenylist: [] },
    };
    expect(buildMysqlAttachString(resolved)).toContain("ssl_mode=preferred");
  });
});
