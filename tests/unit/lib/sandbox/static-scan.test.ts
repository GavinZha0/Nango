import { describe, it, expect } from "vitest";
import { scanCodeStatic } from "@/lib/sandbox/static-scan";

describe("Static Security & WASM AST Scan (scanCodeStatic)", () => {
  it("passes safe python code", async () => {
    const code = `
import json
import duckdb

res = duckdb.query("SELECT 1 as val").fetchall()
print(json.dumps({'rows': res, 'message': 'ok'}))
`;
    const result = await scanCodeStatic(code, "python");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects os.system and subprocess in python (security guardrail priority)", async () => {
    const code = `
import os
os.system("rm -rf /")
`;
    const result = await scanCodeStatic(code, "python");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "BANNED_SUBPROCESS")).toBe(true);
  });

  it("detects eval and exec in python", async () => {
    const code = `
user_input = "__import__('os').system('whoami')"
eval(user_input)
`;
    const result = await scanCodeStatic(code, "python");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "BANNED_DYNAMIC_EVAL")).toBe(true);
  });

  it("detects missing import for pandas (pd) in python code", async () => {
    const code = `
import duckdb
import json

con = duckdb.connect()
df = con.execute("SELECT * FROM read_parquet('./data/*.parquet')").fetchdf()
timestamps = pd.to_datetime(df['ban_expires'])
`;
    const result = await scanCodeStatic(code, "python");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "UNDEFINED_NAME" && v.message.includes("'pd'"))).toBe(true);
  });

  it("detects syntax errors in python code", async () => {
    const code = `
import duckdb
def invalid_syntax(
`;
    const result = await scanCodeStatic(code, "python");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "SYNTAX_ERROR")).toBe(true);
  });

  it("detects child_process in javascript", async () => {
    const code = `
import { spawn } from 'child_process';
spawn('ls');
`;
    const result = await scanCodeStatic(code, "javascript");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "BANNED_CHILD_PROCESS")).toBe(true);
  });

  it("detects undefined variables in javascript", async () => {
    const code = `
const a = 1;
console.log(pd.to_datetime());
`;
    const result = await scanCodeStatic(code, "javascript");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "UNDEFINED_NAME" && v.message.includes("'pd'"))).toBe(true);
  });

  it("detects syntax errors in javascript code", async () => {
    const code = `
const a = ;
`;
    const result = await scanCodeStatic(code, "javascript");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "SYNTAX_ERROR")).toBe(true);
  });
});
