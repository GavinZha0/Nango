import { describe, expect, it } from "vitest";
import { assembleCodeOutput, type RawCodeResult } from "@/lib/sandbox/code-output";

describe("assembleCodeOutput (5-Stage Resolution Pipeline)", () => {
  it("Stage 0: handles execution error when exitCode !== 0", () => {
    const raw: RawCodeResult = {
      exitCode: 1,
      stdout: "",
      stderr: "SyntaxError: invalid syntax",
      durationMs: 120,
    };
    const res = assembleCodeOutput(raw);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("SyntaxError: invalid syntax");
    expect(res.rows).toBeNull();
  });

  it("Stage 1: handles clean JSON output conforming to convention", () => {
    const raw: RawCodeResult = {
      exitCode: 0,
      stdout: JSON.stringify({
        rows: [{ date: "2026-08-16", count: 8 }],
        message: "Success",
      }),
      stderr: "",
      durationMs: 300,
    };
    const res = assembleCodeOutput(raw);
    expect(res.ok).toBe(true);
    expect(res.rows).toEqual([{ date: "2026-08-16", count: 8 }]);
    expect(res.row_count).toBe(1);
    expect(res.message).toBe("Success");
  });

  it("Stage 2: extracts substring JSON when stdout contains extra print() debug logs", () => {
    const rawStdout = `原始数据:
         date  count
0  2026-08-16      8
1  2026-08-09     33

数据时间范围: 2026-07-18 00:00:00 到 2026-08-16 00:00:00

{"rows": [{"date": "2026-07-18", "count": 71}, {"date": "2026-08-16", "count": 8}], "message": "成功补全30天数据"}`;

    const raw: RawCodeResult = {
      exitCode: 0,
      stdout: rawStdout,
      stderr: "",
      durationMs: 700,
    };

    const res = assembleCodeOutput(raw);
    expect(res.ok).toBe(true);
    expect(res.rows).toEqual([
      { date: "2026-07-18", count: 71 },
      { date: "2026-08-16", count: 8 },
    ]);
    expect(res.row_count).toBe(2);
    expect(res.message).toContain("原始数据");
    expect(res.message).toContain("成功补全30天数据");
  });

  it("Stage 3/4: parses Markdown table in stdout into structured rows", () => {
    const markdownStdout = `| date | count |
| --- | --- |
| 2026-08-15 | 10 |
| 2026-08-16 | 20 |`;

    const raw: RawCodeResult = {
      exitCode: 0,
      stdout: markdownStdout,
      stderr: "",
      durationMs: 150,
    };

    const res = assembleCodeOutput(raw);
    expect(res.ok).toBe(true);
    expect(res.rows).toEqual([
      { date: "2026-08-15", count: 10 },
      { date: "2026-08-16", count: 20 },
    ]);
    expect(res.row_count).toBe(2);
  });

  it("Stage 5: falls back gracefully to non-data envelope for pure logic scripts", () => {
    const raw: RawCodeResult = {
      exitCode: 0,
      stdout: "2\nCalculated addition successfully",
      stderr: "",
      durationMs: 50,
    };

    const res = assembleCodeOutput(raw);
    expect(res.ok).toBe(true);
    expect(res.rows).toBeNull();
    expect(res.row_count).toBeNull();
    expect(res.message).toBe("2\nCalculated addition successfully");
  });
});
