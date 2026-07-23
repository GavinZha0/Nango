import { describe, it, expect } from "vitest";
import { scanCodeStatic } from "@/lib/sandbox/static-scan";

describe("Static Security Scan (scanCodeStatic)", () => {
  it("passes safe python code", () => {
    const code = `
import json
import duckdb

res = duckdb.query("SELECT 1 as val").fetchall()
print(json.dumps({'rows': res, 'message': 'ok'}))
`;
    const result = scanCodeStatic(code, "python");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects os.system and subprocess in python", () => {
    const code = `
import os
os.system("rm -rf /")
`;
    const result = scanCodeStatic(code, "python");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "BANNED_SUBPROCESS")).toBe(true);
  });

  it("detects eval and exec in python", () => {
    const code = `
user_input = "__import__('os').system('whoami')"
eval(user_input)
`;
    const result = scanCodeStatic(code, "python");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "BANNED_DYNAMIC_EVAL")).toBe(true);
  });

  it("detects child_process in javascript", () => {
    const code = `
import { spawn } from 'child_process';
spawn('ls');
`;
    const result = scanCodeStatic(code, "javascript");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.ruleId === "BANNED_CHILD_PROCESS")).toBe(true);
  });
});
