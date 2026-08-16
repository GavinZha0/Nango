import { describe, expect, it } from "vitest";
import { sanitizeConnectionStringError } from "../sanitization";

describe("sanitizeConnectionStringError", () => {
  it("strips libpq connection strings and replaces with data source name", () => {
    const rawError =
      'IO Error: Unable to connect to Postgres at "host=nango-db port=5432 dbname=nango user=nango password=nango": could not translate host name "nango-db" to address: Name or service not known\n';

    const sanitized = sanitizeConnectionStringError(rawError, "nango-db");

    expect(sanitized).not.toContain("password=nango");
    expect(sanitized).not.toContain("user=nango");
    expect(sanitized).not.toContain("port=5432");
    expect(sanitized).not.toContain("dbname=nango");
    expect(sanitized).toContain('at data source "nango-db"');
    expect(sanitized).toContain('could not translate host name "nango-db" to address');
  });

  it("handles missing data source name gracefully", () => {
    const rawError =
      'IO Error: Unable to connect to Postgres at "host=prod-db port=5432 dbname=mydb user=admin password=secret": connection timeout';

    const sanitized = sanitizeConnectionStringError(rawError);

    expect(sanitized).not.toContain("password=secret");
    expect(sanitized).not.toContain("user=admin");
    expect(sanitized).toContain("at data source");
    expect(sanitized).toContain("connection timeout");
  });

  it("redacts URL style connection strings", () => {
    const rawError = "Failed to connect to postgresql://user:password123@db.example.com:5432/main_db";

    const sanitized = sanitizeConnectionStringError(rawError, "my-pg");

    expect(sanitized).not.toContain("password123");
    expect(sanitized).toContain("postgresql://[REDACTED_CREDENTIALS]");
  });

  it("returns unchanged text if no connection parameters present", () => {
    const rawError = "Syntax error near SELECT";
    const sanitized = sanitizeConnectionStringError(rawError, "my-pg");
    expect(sanitized).toBe("Syntax error near SELECT");
  });
});
