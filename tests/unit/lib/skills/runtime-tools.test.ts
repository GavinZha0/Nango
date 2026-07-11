import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// `getDbSkillStorage` is the only external surface runtime-tools.ts
// touches besides the sandbox adapter — mock both so we can assert
// the wiring shape without standing up Postgres or a real sandbox.
// `vi.mock` calls are hoisted, so any state they reference must come
// from `vi.hoisted` (which is hoisted to the same place).
const mocks = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  adapterRunMock: vi.fn(),
  getActiveAdapterMock: vi.fn(),
}));

vi.mock("@/lib/skills/storage", () => ({
  getDbSkillStorage: () => ({ readFile: mocks.readFileMock }),
  InvalidSkillPathError: class InvalidSkillPathError extends Error {},
}));

vi.mock("@/lib/sandbox/registry.server", () => ({
  getActiveAdapter: mocks.getActiveAdapterMock,
}));

const { readFileMock, adapterRunMock, getActiveAdapterMock } = mocks;

import { buildSkillsRuntime } from "@/lib/skills/runtime-tools";
import type { SkillSpec } from "@/lib/skills/skill-pool";

const SPEC: SkillSpec = {
  skillId: "skill-uuid-1",
  name: "csv_summarize",
  description: "Summarise a CSV.",
  skillMd: "# CSV Summarize\nbody",
  parsed: { name: "csv_summarize", description: "Summarise a CSV." } as unknown as SkillSpec["parsed"],
  source: "builtin",
  enabled: true,
  visibility: "public",
  createdBy: null,
};

function findTool(name: string) {
  const { tools } = buildSkillsRuntime({ specs: [SPEC] });
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

beforeEach(() => {
  readFileMock.mockReset();
  adapterRunMock.mockReset();
  getActiveAdapterMock.mockReset();
  getActiveAdapterMock.mockResolvedValue({
    backend: "subprocess",
    run: adapterRunMock,
  });
});

describe("run_skill_script", () => {
  it("rejects an unknown skill name with the available list", async () => {
    const tool = findTool("run_skill_script");
    const r = (await tool.execute!({ name: "nope", filename: "a.py" })) as {
      ok: false;
      error: string;
      available: string[];
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nope");
    expect(r.available).toEqual(["csv_summarize"]);
  });

  it("rejects an unsupported extension before touching storage", async () => {
    const tool = findTool("run_skill_script");
    const r = (await tool.execute!({
      name: "csv_summarize",
      filename: "weird.exe",
    })) as { ok: false; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Unsupported extension");
    expect(readFileMock).not.toHaveBeenCalled();
    expect(adapterRunMock).not.toHaveBeenCalled();
  });

  it("returns 'not found' when the script row is missing", async () => {
    readFileMock.mockResolvedValue(null);
    const tool = findTool("run_skill_script");
    const r = (await tool.execute!({
      name: "csv_summarize",
      filename: "missing.py",
    })) as { ok: false; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Script not found");
    expect(readFileMock).toHaveBeenCalledWith("skill-uuid-1", "scripts/missing.py");
    expect(adapterRunMock).not.toHaveBeenCalled();
  });

  it("normalises a bare filename to scripts/<filename>", async () => {
    readFileMock.mockResolvedValue(null);
    const tool = findTool("run_skill_script");
    await tool.execute!({ name: "csv_summarize", filename: "analyze.py" });
    expect(readFileMock).toHaveBeenCalledWith("skill-uuid-1", "scripts/analyze.py");
  });

  it("accepts an explicit scripts/ prefix unchanged", async () => {
    readFileMock.mockResolvedValue(null);
    const tool = findTool("run_skill_script");
    await tool.execute!({
      name: "csv_summarize",
      filename: "scripts/nested/inner.py",
    });
    expect(readFileMock).toHaveBeenCalledWith(
      "skill-uuid-1",
      "scripts/nested/inner.py",
    );
  });

  it("delegates to adapter.run with python3 - + script bytes via stdin", async () => {
    const scriptBody = "print('hello from skill')\n";
    readFileMock.mockResolvedValue({
      path: "scripts/analyze.py",
      content: Buffer.from(scriptBody, "utf-8"),
      contentType: null,
      size: scriptBody.length,
    });
    adapterRunMock.mockResolvedValue({
      stdout: "hello from skill\n",
      stderr: "",
      exitCode: 0,
      durationMs: 12,
    });

    const tool = findTool("run_skill_script");
    const r = (await tool.execute!({
      name: "csv_summarize",
      filename: "analyze.py",
      datasets: ["sales_q1"],
    })) as {
      ok: boolean;
      message: string | null;
      backend: string;
    };

    expect(adapterRunMock).toHaveBeenCalledTimes(1);
    expect(adapterRunMock.mock.calls[0][0]).toEqual({
      command: ["python3", "-"],
      stdin: scriptBody,
      datasets: ["sales_q1"],
    });
    // run_skill_script returns { ...assembleCodeOutput(out), backend }.
    // "hello from skill\n" is not valid JSON → message = raw stdout.
    expect(r.ok).toBe(true);
    expect(r.message).toBe("hello from skill\n");
    expect(r.backend).toBe("subprocess");
  });

  it("dispatches .sh to bash", async () => {
    const scriptBody = "#!/usr/bin/env bash\necho hi\n";
    readFileMock.mockResolvedValue({
      path: "scripts/run.sh",
      content: Buffer.from(scriptBody, "utf-8"),
      contentType: null,
      size: scriptBody.length,
    });
    adapterRunMock.mockResolvedValue({
      stdout: "hi\n",
      stderr: "",
      exitCode: 0,
      durationMs: 5,
    });

    const tool = findTool("run_skill_script");
    await tool.execute!({ name: "csv_summarize", filename: "run.sh" });
    expect(adapterRunMock.mock.calls[0][0].command).toEqual(["bash", "-"]);
  });

  it("does NOT expose stdin as a tool parameter", () => {
    const tool = findTool("run_skill_script");
    // Zod schema reflection — stdin must not be a known key.
    const schemaShape = (tool.parameters as { shape?: Record<string, unknown> })
      .shape;
    if (schemaShape) {
      expect(schemaShape).not.toHaveProperty("stdin");
    }
  });
});
