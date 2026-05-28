import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ADAPTERS, getDataSourceAdapter } from "@/lib/data-sources/registry";
import {
  DATA_SOURCE_IDS,
  isSupportedDataSource,
  type DataSourceId,
} from "@/lib/data-sources/types";

describe("data-source registry", () => {
  it("declares the same ids as DATA_SOURCE_IDS", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([...DATA_SOURCE_IDS].sort());
  });

  it.each([
    ["postgres", "PostgreSQL", "database"],
    ["mysql", "MySQL", "database"],
    ["mariadb", "MariaDB", "database"],
    ["vertica", "Vertica", "database"],
  ] as const)(
    "registers %s with the right metadata",
    (id, displayName, category) => {
      const a = getDataSourceAdapter(id as DataSourceId);
      expect(a.id).toBe(id);
      expect(a.displayName).toBe(displayName);
      expect(a.category).toBe(category);
    },
  );

  it("isSupportedDataSource accepts ids and rejects others", () => {
    expect(isSupportedDataSource("postgres")).toBe(true);
    expect(isSupportedDataSource("mysql")).toBe(true);
    expect(isSupportedDataSource("mariadb")).toBe(true);
    expect(isSupportedDataSource("vertica")).toBe(true);
    expect(isSupportedDataSource("oracle")).toBe(false);
    expect(isSupportedDataSource("")).toBe(false);
  });

  it("each adapter exposes a parseable Zod secrets schema", () => {
    for (const a of Object.values(ADAPTERS)) {
      expect(typeof a.secretsSchema.parse).toBe("function");
    }
  });
});
