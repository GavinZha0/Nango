import { describe, expect, it } from "vitest";

import { validateSqlAgainstPolicy } from "@/lib/data-sources/policy";
import type { DataSourcePolicy } from "@/lib/data-sources/types";

const open: DataSourcePolicy = {
  readOnly: false,
  tableAllowlist: null,
  tableDenylist: [],
};

const readOnly: DataSourcePolicy = {
  readOnly: true,
  tableAllowlist: null,
  tableDenylist: [],
};

describe("validateSqlAgainstPolicy — readOnly", () => {
  it("permits SELECT on read-only", () => {
    const r = validateSqlAgainstPolicy("SELECT 1", "postgres", readOnly);
    expect(r.ok).toBe(true);
  });

  it("rejects INSERT on read-only", () => {
    const r = validateSqlAgainstPolicy(
      "INSERT INTO users (id) VALUES (1)",
      "postgres",
      readOnly,
    );
    expect(r).toMatchObject({ ok: false, code: "WRITE_NOT_ALLOWED" });
  });

  it("rejects UPDATE on read-only", () => {
    const r = validateSqlAgainstPolicy(
      "UPDATE users SET name = 'x'",
      "postgres",
      readOnly,
    );
    expect(r).toMatchObject({ ok: false, code: "WRITE_NOT_ALLOWED" });
  });

  it("rejects DELETE on read-only", () => {
    const r = validateSqlAgainstPolicy(
      "DELETE FROM users WHERE id = 1",
      "postgres",
      readOnly,
    );
    expect(r).toMatchObject({ ok: false, code: "WRITE_NOT_ALLOWED" });
  });

  it("permits writes when readOnly is off", () => {
    const r = validateSqlAgainstPolicy(
      "INSERT INTO users (id) VALUES (1)",
      "postgres",
      open,
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateSqlAgainstPolicy — tableDenylist", () => {
  const policy: DataSourcePolicy = {
    readOnly: true,
    tableAllowlist: null,
    tableDenylist: ["users_pii", "audit_log"],
  };

  it("rejects a denied table", () => {
    const r = validateSqlAgainstPolicy(
      "SELECT * FROM users_pii",
      "postgres",
      policy,
    );
    expect(r).toMatchObject({ ok: false, code: "TABLE_DENIED" });
  });

  it("rejects denied tables hit via JOIN", () => {
    const r = validateSqlAgainstPolicy(
      "SELECT u.id FROM users u JOIN audit_log a ON a.user_id = u.id",
      "postgres",
      policy,
    );
    expect(r).toMatchObject({ ok: false, code: "TABLE_DENIED" });
  });

  it("permits queries that avoid denied tables", () => {
    const r = validateSqlAgainstPolicy(
      "SELECT id FROM users",
      "postgres",
      policy,
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateSqlAgainstPolicy — tableAllowlist", () => {
  const policy: DataSourcePolicy = {
    readOnly: true,
    tableAllowlist: ["users", "orders"],
    tableDenylist: [],
  };

  it("permits an allowlisted table", () => {
    const r = validateSqlAgainstPolicy(
      "SELECT * FROM users",
      "postgres",
      policy,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a non-allowlisted table", () => {
    const r = validateSqlAgainstPolicy(
      "SELECT * FROM secrets",
      "postgres",
      policy,
    );
    expect(r).toMatchObject({ ok: false, code: "TABLE_NOT_ALLOWED" });
  });

  it("denylist still wins over allowlist when both exist", () => {
    const both: DataSourcePolicy = {
      readOnly: true,
      tableAllowlist: ["users", "orders"],
      tableDenylist: ["users"],
    };
    const r = validateSqlAgainstPolicy(
      "SELECT * FROM users",
      "postgres",
      both,
    );
    expect(r).toMatchObject({ ok: false, code: "TABLE_DENIED" });
  });
});

describe("validateSqlAgainstPolicy — CTE handling", () => {
  // node-sql-parser's tableList includes CTE names as if they were
  // real tables; collectCteNames() should strip them so they do not
  // trigger spurious deny / non-allow violations.
  it("CTE name does not trip the allowlist", () => {
    const policy: DataSourcePolicy = {
      readOnly: true,
      tableAllowlist: ["users"],
      tableDenylist: [],
    };
    const r = validateSqlAgainstPolicy(
      "WITH active AS (SELECT * FROM users) SELECT * FROM active",
      "postgres",
      policy,
    );
    expect(r.ok).toBe(true);
  });

  it("CTE body's real table is still validated", () => {
    const policy: DataSourcePolicy = {
      readOnly: true,
      tableAllowlist: ["users"],
      tableDenylist: [],
    };
    const r = validateSqlAgainstPolicy(
      "WITH leaked AS (SELECT * FROM secrets) SELECT * FROM leaked",
      "postgres",
      policy,
    );
    expect(r).toMatchObject({ ok: false, code: "TABLE_NOT_ALLOWED" });
  });
});

describe("validateSqlAgainstPolicy — dialects", () => {
  it("MySQL dialect parses LIMIT offset, count syntax", () => {
    const r = validateSqlAgainstPolicy(
      "SELECT * FROM users LIMIT 10, 5",
      "mysql",
      readOnly,
    );
    expect(r.ok).toBe(true);
  });

  it("Vertica routes through PostgreSQL dialect", () => {
    const r = validateSqlAgainstPolicy(
      "SELECT * FROM users",
      "vertica",
      readOnly,
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateSqlAgainstPolicy — bad input", () => {
  it("garbage SQL surfaces PARSE_ERROR (fail closed)", () => {
    const r = validateSqlAgainstPolicy(
      "this is not sql at all",
      "postgres",
      readOnly,
    );
    expect(r).toMatchObject({ ok: false, code: "PARSE_ERROR" });
  });
});
