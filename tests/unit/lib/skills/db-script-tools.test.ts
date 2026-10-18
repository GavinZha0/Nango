import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const { extractMock } = vi.hoisted(() => ({ extractMock: vi.fn() }));

vi.mock("@/lib/data-sources/runtime-tools", () => ({
  extractDatasetForAgent: extractMock,
}));

const { storageMock } = vi.hoisted(() => ({
  storageMock: { readFile: vi.fn() },
}));

vi.mock("@/lib/skills/storage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/skills/storage")>();
  return { ...actual, getDbSkillStorage: () => storageMock };
});

import { buildRunSkillSqlScriptTool } from "@/lib/skills/db-script-tools";
import type { SkillSpec } from "@/lib/skills/skill-pool";

type ToolLike = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const SQL_PATH = "scripts/reports/sales.sql";
const SQL_TEXT = "SELECT * FROM users;";

function makeSpec(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    skillId: "skill-1",
    name: "sales-report",
    description: "A skill with a SQL report",
    skillMd: "---\nname: sales-report\ndescription: ...\n---",
    parsed: {} as SkillSpec["parsed"],
    enabled: true,
    visibility: "private",
    createdBy: "user-1",
    scriptsOnSsh: new Set(),
    scriptsOnDb: new Set([SQL_PATH]),
    ...overrides,
  };
}

let tool: ToolLike;

beforeEach(() => {
  extractMock.mockReset();
  storageMock.readFile.mockReset();
  tool = buildRunSkillSqlScriptTool({
    specs: [makeSpec()],
    agentDataSourceIds: ["ds-1"],
  }) as unknown as ToolLike;
});

describe("run_skill_sql_script", () => {
  it("executes a declared SQL file and returns the dataset result", async () => {
    storageMock.readFile.mockResolvedValue({
      skillId: "skill-1",
      path: SQL_PATH,
      content: Buffer.from(SQL_TEXT),
      size: SQL_TEXT.length,
      contentType: "text/plain",
    });
    extractMock.mockResolvedValue({
      cache_hit: false,
      dataset_name: "sales",
      total_rows: 1,
      returned_rows: 1,
      rows: [{ id: 1 }],
      row_schema: { columns: [] },
      ttl_hours: 24,
    });

    const result = await tool.execute({
      name: "sales-report",
      filename: "reports/sales.sql",
      dataSourceName: "prod_pg",
      datasetName: "sales",
      rowLimit: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.skill).toBe("sales-report");
    expect(result.script).toBe(SQL_PATH);
    expect(result.scriptSha256).toBe(
      createHash("sha256").update(SQL_TEXT).digest("hex"),
    );
    expect(result.dataSourceName).toBe("prod_pg");
    expect(result.cache_hit).toBe(false);
    expect(extractMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataSourceName: "prod_pg",
        datasetName: "sales",
        sqlText: SQL_TEXT,
        rowLimit: 5,
      }),
      ["ds-1"],
    );
  });

  it("accepts the scripts/-prefixed filename", async () => {
    storageMock.readFile.mockResolvedValue({
      skillId: "skill-1",
      path: SQL_PATH,
      content: Buffer.from(SQL_TEXT),
      size: SQL_TEXT.length,
      contentType: "text/plain",
    });
    extractMock.mockResolvedValue({
      cache_hit: false,
      dataset_name: "sales",
      total_rows: 0,
      returned_rows: 0,
      rows: [],
      row_schema: { columns: [] },
      ttl_hours: 24,
    });

    const result = await tool.execute({
      name: "sales-report",
      filename: SQL_PATH,
      dataSourceName: "prod_pg",
      datasetName: "sales",
    });

    expect(result.ok).toBe(true);
    expect(storageMock.readFile).toHaveBeenCalledWith("skill-1", SQL_PATH);
  });

  it("returns SKILL_NOT_FOUND for an unbound skill", async () => {
    const result = await tool.execute({
      name: "other",
      filename: "reports/sales.sql",
      dataSourceName: "prod_pg",
      datasetName: "sales",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("SKILL_NOT_FOUND");
    expect(storageMock.readFile).not.toHaveBeenCalled();
  });

  it("returns NOT_A_DB_SCRIPT with the ad-hoc SQL hint", async () => {
    const result = await tool.execute({
      name: "sales-report",
      filename: "reports/other.sql",
      dataSourceName: "prod_pg",
      datasetName: "sales",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("NOT_A_DB_SCRIPT");
    expect(result.message).toContain("extract_dataset_by_sql");
    expect(storageMock.readFile).not.toHaveBeenCalled();
  });

  it("returns UNSUPPORTED_EXTENSION for a non-.sql declaration", async () => {
    tool = buildRunSkillSqlScriptTool({
      specs: [
        makeSpec({
          scriptsOnDb: new Set(["scripts/reports/sales.txt"]),
        }),
      ],
      agentDataSourceIds: ["ds-1"],
    }) as unknown as ToolLike;

    const result = await tool.execute({
      name: "sales-report",
      filename: "reports/sales.txt",
      dataSourceName: "prod_pg",
      datasetName: "sales",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("UNSUPPORTED_EXTENSION");
    expect(storageMock.readFile).not.toHaveBeenCalled();
  });

  it("returns SCRIPT_NOT_FOUND when the skill file is missing", async () => {
    storageMock.readFile.mockResolvedValue(null);

    const result = await tool.execute({
      name: "sales-report",
      filename: "reports/sales.sql",
      dataSourceName: "prod_pg",
      datasetName: "sales",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("SCRIPT_NOT_FOUND");
  });

  it("rejects invalid UTF-8 / NUL bytes", async () => {
    storageMock.readFile.mockResolvedValue({
      skillId: "skill-1",
      path: SQL_PATH,
      content: Buffer.from([0x53, 0x00, 0x4c]),
      size: 3,
      contentType: "text/plain",
    });

    const result = await tool.execute({
      name: "sales-report",
      filename: "reports/sales.sql",
      dataSourceName: "prod_pg",
      datasetName: "sales",
    });

    expect(result.error).toBe("INVALID_SCRIPT_BYTES");
  });

  it("rejects an empty SQL file", async () => {
    storageMock.readFile.mockResolvedValue({
      skillId: "skill-1",
      path: SQL_PATH,
      content: Buffer.from("   \n"),
      size: 4,
      contentType: "text/plain",
    });

    const result = await tool.execute({
      name: "sales-report",
      filename: "reports/sales.sql",
      dataSourceName: "prod_pg",
      datasetName: "sales",
    });

    expect(result.error).toBe("EMPTY_SQL");
  });

  it("propagates data source policy / extraction errors", async () => {
    storageMock.readFile.mockResolvedValue({
      skillId: "skill-1",
      path: SQL_PATH,
      content: Buffer.from("SELECT 1; SELECT 2"),
      size: 23,
      contentType: "text/plain",
    });
    extractMock.mockResolvedValue({
      ok: false,
      error: {
        code: "MULTIPLE_STATEMENTS",
        message: "Only a single SQL statement is supported.",
      },
    });

    const result = await tool.execute({
      name: "sales-report",
      filename: "reports/sales.sql",
      dataSourceName: "prod_pg",
      datasetName: "sales",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("MULTIPLE_STATEMENTS");
    expect(result.message).toContain("single SQL statement");
  });
});
