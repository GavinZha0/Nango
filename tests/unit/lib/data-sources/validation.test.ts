import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createDataSourceSchema,
  updateDataSourceSchema,
} from "@/lib/data-sources/validation";

const validBody = {
  name: "prod_pg_readonly",
  provider: "postgres",
  // v4 UUID — the strict Zod validator rejects all-zero / nil UUIDs
  // unless they're literal nil, and rejects unknown versions.
  credentialId: "c0a801fe-0000-4000-8000-000000000001",
  host: "10.0.0.5",
  port: 5432,
  database: "sales",
};

describe("createDataSourceSchema", () => {
  it("accepts a minimal valid payload", () => {
    const r = createDataSourceSchema.safeParse(validBody);
    expect(r.success).toBe(true);
  });

  it("leaves params undefined when omitted (route handler defaults to {})", () => {
    const r = createDataSourceSchema.parse(validBody);
    expect(r.params).toBeUndefined();
  });

  it.each([
    ["empty name", { ...validBody, name: "" }],
    ["name starts with digit", { ...validBody, name: "1abc" }],
    ["name with uppercase", { ...validBody, name: "Prod_PG" }],
    ["name with space", { ...validBody, name: "prod pg" }],
    ["name with /", { ...validBody, name: "prod/pg" }],
    ["name longer than 63 chars", { ...validBody, name: "a".repeat(64) }],
  ])("rejects %s", (_label, body) => {
    expect(createDataSourceSchema.safeParse(body).success).toBe(false);
  });

  it("rejects unknown provider", () => {
    const r = createDataSourceSchema.safeParse({
      ...validBody,
      provider: "snowflake",
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-uuid credentialId", () => {
    const r = createDataSourceSchema.safeParse({
      ...validBody,
      credentialId: "not-a-uuid",
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-positive port", () => {
    expect(
      createDataSourceSchema.safeParse({ ...validBody, port: 0 }).success,
    ).toBe(false);
    expect(
      createDataSourceSchema.safeParse({ ...validBody, port: -1 }).success,
    ).toBe(false);
  });

  it("rejects port above 65535", () => {
    expect(
      createDataSourceSchema.safeParse({ ...validBody, port: 70000 }).success,
    ).toBe(false);
  });

  it("accepts tableAllowlist as null (no constraint)", () => {
    const r = createDataSourceSchema.parse({
      ...validBody,
      tableAllowlist: null,
    });
    expect(r.tableAllowlist).toBeNull();
  });

  it("accepts tableAllowlist as array of names", () => {
    const r = createDataSourceSchema.parse({
      ...validBody,
      tableAllowlist: ["users", "orders"],
    });
    expect(r.tableAllowlist).toEqual(["users", "orders"]);
  });

  it("accepts params as Record<string,string>", () => {
    const r = createDataSourceSchema.parse({
      ...validBody,
      params: { timezone: "UTC", connectTimeout: "30" },
    });
    expect(r.params).toEqual({ timezone: "UTC", connectTimeout: "30" });
  });
});

describe("updateDataSourceSchema", () => {
  it("accepts an empty patch", () => {
    expect(updateDataSourceSchema.parse({})).toEqual({});
  });

  it("rejects unknown fields (.strict)", () => {
    const r = updateDataSourceSchema.safeParse({ name: "renamed" });
    expect(r.success).toBe(false);
  });

  it("does NOT accept name (rename is unsupported)", () => {
    // name is not in the schema at all; .strict() rejects it.
    const r = updateDataSourceSchema.safeParse({ name: "anything" });
    expect(r.success).toBe(false);
  });

  it("accepts a provider change (mutable)", () => {
    const r = updateDataSourceSchema.parse({ provider: "mysql" });
    expect(r.provider).toBe("mysql");
  });

  it("rejects an unknown provider", () => {
    const r = updateDataSourceSchema.safeParse({ provider: "snowflake" });
    expect(r.success).toBe(false);
  });

  it("accepts a credentialId swap", () => {
    const r = updateDataSourceSchema.parse({
      credentialId: "c0a801fe-0000-4000-8000-000000000002",
    });
    expect(r.credentialId).toBe("c0a801fe-0000-4000-8000-000000000002");
  });

  it("accepts setting tableAllowlist to null", () => {
    const r = updateDataSourceSchema.parse({ tableAllowlist: null });
    expect(r.tableAllowlist).toBeNull();
  });
});
