import { describe, expect, it } from "vitest";
import { sanitizeAdminTestError, sanitizeConnectionStringError } from "@/lib/data-sources/sanitization";

describe("sanitizeConnectionStringError (Agent format)", () => {
  it("simplifies connection failure messages to a clean data source format", () => {
    const rawError =
      'IO Error: Unable to connect to Postgres at data source "nango-db"password=******": connection to server at "localhost" (::1), port 5432 failed: Connection refused (0x0000274D/10061)';

    const sanitized = sanitizeConnectionStringError(rawError, "nango-db");

    expect(sanitized).toBe('IO Error: Unable to connect to Postgres data source "nango-db"');
  });

  it("handles DNS lookup failures concisely", () => {
    const rawError =
      'IO Error: Unable to connect to Postgres at "host=nango-db port=5432 dbname=nango user=nango password=nango": could not translate host name "nango-db" to address: Name or service not known\n';

    const sanitized = sanitizeConnectionStringError(rawError, "nango-db");

    expect(sanitized).toBe('IO Error: Unable to connect to Postgres data source "nango-db"');
  });

  it("handles missing data source name gracefully for connection errors", () => {
    const rawError =
      'IO Error: Unable to connect to MySQL at "host=prod-db port=3306 dbname=mydb user=admin password=secret": connection timeout';

    const sanitized = sanitizeConnectionStringError(rawError);

    expect(sanitized).toBe("IO Error: Unable to connect to MySQL data source");
  });

  it("preserves actionable SQL query errors for Agent self-repair", () => {
    const rawSqlError = 'Catalog Error: Table with name "non_existent_table" does not exist!';
    const sanitized = sanitizeConnectionStringError(rawSqlError, "nango-db");

    expect(sanitized).toBe('Catalog Error: Table with name "non_existent_table" does not exist!');
  });
});

describe("sanitizeAdminTestError (Admin UI Test Connection format)", () => {
  it("preserves host, port, dbname, user, and failure details but masks password", () => {
    const rawError =
      'IO Error: Unable to connect to Postgres at "host=nango-db port=5432 dbname=nango user=nango password=my_secret_pass": could not translate host name "nango-db" to address: Name or service not known';

    const sanitized = sanitizeAdminTestError(rawError);

    expect(sanitized).not.toContain("my_secret_pass");
    expect(sanitized).toContain("password=******");
    expect(sanitized).toContain("host=nango-db");
    expect(sanitized).toContain("port=5432");
    expect(sanitized).toContain("dbname=nango");
    expect(sanitized).toContain("user=nango");
    expect(sanitized).toContain('could not translate host name "nango-db" to address');
  });

  it("masks URL embedded passwords", () => {
    const rawError = "Failed to connect to postgresql://admin:super_secret_pwd@prod-db:5432/main_db";

    const sanitized = sanitizeAdminTestError(rawError);

    expect(sanitized).not.toContain("super_secret_pwd");
    expect(sanitized).toContain("postgresql://[user]:******@prod-db:5432/main_db");
  });
});
