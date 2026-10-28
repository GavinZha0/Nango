import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createDrizzleMock } = await import("tests/unit/helpers");
  return { db: createDrizzleMock() };
});

import { db } from "@/lib/db";
import type { MockDrizzleDb } from "tests/unit/helpers";
import {
  filterVisibleDataSourceIds,
  filterVisibleMcpServerIds,
  filterVisibleSkillIds,
  filterVisibleSshServerIds,
} from "@/lib/runner/dispatch/visibility";

const dbMock = db as unknown as MockDrizzleDb;

beforeEach(() => {
  dbMock.$reset();
});

describe("dispatch visibility filter", () => {
  it("fails closed for every resource type when no runner identity exists", async () => {
    await expect(filterVisibleSkillIds(["s-1"], undefined)).resolves.toEqual(new Set());
    await expect(filterVisibleSshServerIds(["h-1"], undefined)).resolves.toEqual(new Set());
    await expect(filterVisibleDataSourceIds(["d-1"], undefined)).resolves.toEqual(new Set());
    await expect(filterVisibleMcpServerIds(["m-1"], undefined)).resolves.toEqual(new Set());
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("returns an empty set without querying for an empty id list", async () => {
    await expect(filterVisibleSkillIds([], { userId: "u-1" })).resolves.toEqual(new Set());
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("projects only the ids the query returns", async () => {
    dbMock.$enqueue([{ id: "s-1" }, { id: "s-3" }]);
    const result = await filterVisibleSkillIds(["s-1", "s-2", "s-3"], {
      userId: "u-1",
    });
    expect(result).toEqual(new Set(["s-1", "s-3"]));
  });
});
