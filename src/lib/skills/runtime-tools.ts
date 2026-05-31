/**
 * Per-agent server-side skill tools: `get_skill`, `get_skill_file`,
 * `run_skill_script`.
 *
 * See docs/skills.md.
 */

import "server-only";

import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import { z } from "zod";

import {
  getDbSkillStorage,
  InvalidSkillPathError,
  type SkillFileRecord,
} from "./storage";
import type { SkillSpec } from "./skill-pool";
import { getActiveAdapter } from "@/lib/sandbox/registry.server";

/** Subdirectory whitelist (matches `validateSkillFilePath`). */
const ALLOWED_PREFIXES = ["references", "scripts", "assets", "evals"] as const;

/**
 * Interpreter dispatch by file extension. Adding a language requires both a
 * row here AND the binary in the sandbox rootfs (see `docker/sandbox/Dockerfile`).
 * Extensions matched case-insensitively.
 */
const INTERPRETER_BY_EXTENSION: Record<string, string> = {
  py: "python3",
  sh: "bash",
};

function pickInterpreter(filename: string): string | null {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  return INTERPRETER_BY_EXTENSION[m[1]] ?? null;
}

export interface BuildSkillsRuntimeArgs {
  specs: SkillSpec[];
}

export interface SkillsRuntime {
  /** Tools to merge into `BuiltInAgent`'s `tools` array.  Empty if no skills. */
  tools: ToolDefinition[];
  /** Markdown block to append to the agent's prompt.  Empty when no skills. */
  promptBlock: string;
}

export function buildSkillsRuntime(args: BuildSkillsRuntimeArgs): SkillsRuntime {
  const { specs } = args;
  if (specs.length === 0) {
    return { tools: [], promptBlock: "" };
  }

  // QUIRK: defensively keep the first on name collision rather than
  // throwing inside an LLM tool call. DB enforces name uniqueness so
  // this only matters if a bug slips a duplicate through.
  const byName: Map<string, SkillSpec> = new Map();
  for (const spec of specs) {
    if (!byName.has(spec.name)) byName.set(spec.name, spec);
  }

  const promptBlock: string = renderPromptBlock(specs);
  const storage = getDbSkillStorage();

  const getSkill = defineTool({
    name: "get_skill",
    description:
      "Load the full SKILL.md instructions for a named skill.  Call this when the user's request matches a skill listed in the system prompt's 'Available Skills' section.  The returned text contains the procedure, when-to-use rules, and pointers to helper files reachable via get_skill_file.",
    parameters: z.object({
      name: z
        .string()
        .describe("The skill name as listed in 'Available Skills'."),
    }),
    execute: async ({ name }) => {
      const spec: SkillSpec | undefined = byName.get(name);
      if (!spec) {
        return {
          ok: false,
          error: `No skill named "${name}" is available to this agent.`,
          available: [...byName.keys()],
        };
      }
      return { ok: true, name: spec.name, skillMd: spec.skillMd };
    },
  });

  const getSkillFile = defineTool({
    name: "get_skill_file",
    description:
      "Read a helper file from a skill's tree (references/, scripts/, assets/, evals/).  Pass a bare filename to search those subdirectories in order, or a relative path like 'references/output-format.md' to target one directly.",
    parameters: z.object({
      name: z.string().describe("Skill name."),
      filename: z
        .string()
        .describe(
          "Bare filename (searched in references/, scripts/, assets/, evals/) or a relative path under one of those subdirectories.",
        ),
    }),
    execute: async ({ name, filename }) => {
      const spec: SkillSpec | undefined = byName.get(name);
      if (!spec) {
        return { ok: false, error: `No skill named "${name}" is available to this agent.` };
      }
      if (!filename || filename.length === 0) {
        return { ok: false, error: "Missing filename." };
      }

      // Build the candidate-path list. With a separator, the path is
      // taken as-is (must already be under one of the four prefixes).
      // Without a separator, try each prefix in order. Validation
      // rejects oversized / traversal / dotfile paths up front so
      // we never poke the DB with garbage.
      const candidates: string[] = filename.includes("/")
        ? [filename]
        : ALLOWED_PREFIXES.map((p) => `${p}/${filename}`);

      let found: SkillFileRecord | null = null;
      for (const candidate of candidates) {
        try {
          const rec = await storage.readFile(spec.skillId, candidate);
          if (rec) {
            found = rec;
            break;
          }
        } catch (err) {
          if (err instanceof InvalidSkillPathError) continue;
          throw err;
        }
      }

      if (!found) {
        return { ok: false, error: `File not found: ${filename}` };
      }

      const isText: boolean = isLikelyText(found.content);
      return {
        ok: true,
        path: found.path,
        encoding: isText ? "utf8" : "base64",
        content: isText
          ? found.content.toString("utf8")
          : found.content.toString("base64"),
        size: found.size,
      };
    },
  });

  // SECURITY: `run_skill_script` runs pre-vetted bytes from
  // `skill_file`; `run_code_in_sandbox` runs LLM-authored code. Both
  // share the same sandbox plumbing (`getActiveAdapter().run`) —
  // this tool is a façade, not a parallel path. Script bytes are
  // fed via stdin (`python3 -` / `bash -`); stdin is NOT exposed as
  // a parameter so script source cannot be substituted by the LLM.
  const runSkillScript = defineTool({
    name: "run_skill_script",
    description:
      "Execute a script bundled with a skill (scripts/<filename>) in the same sandbox as run_code_in_sandbox (no network, read-only rootfs, memory/CPU/timeout limits). Interpreter is picked from the file extension: .py → python3, .sh → bash. Pass `datasets` to expose cached Parquet datasets read-only at ./data/<name>/ in the sandbox cwd — same convention as run_code_in_sandbox. Returns { stdout, stderr, exitCode, durationMs, backend, termination? }.",
    parameters: z.object({
      name: z.string().describe("Skill name."),
      filename: z
        .string()
        .describe(
          "Script filename, e.g. 'analyze.py'. Looked up under the skill's scripts/ directory; pass either 'analyze.py' or 'scripts/analyze.py'.",
        ),
      datasets: z
        .array(z.string())
        .optional()
        .describe(
          "Cached dataset names (from extract_dataset_by_sql) to expose read-only at ./data/<name>/ in the sandbox cwd.",
        ),
    }),
    execute: async ({ name, filename, datasets }) => {
      // 1. Resolve skill (must be bound to this agent).
      const spec: SkillSpec | undefined = byName.get(name);
      if (!spec) {
        return {
          ok: false,
          error: `No skill named "${name}" is available to this agent.`,
          available: [...byName.keys()],
        };
      }

      // 2. Pick interpreter from extension before we touch the DB.
      const interpreter: string | null = pickInterpreter(filename);
      if (!interpreter) {
        return {
          ok: false,
          error:
            `Unsupported extension on "${filename}". V1 supports .py ` +
            `(python3) and .sh (bash). Add the language to the rootfs ` +
            `and the dispatch table to extend.`,
        };
      }

      // 3. Resolve script bytes. Restricted to scripts/ on purpose —
      //    running a markdown reference or asset doesn't make sense
      //    and broadens the surface for no benefit.
      const scriptPath: string = filename.startsWith("scripts/")
        ? filename
        : `scripts/${filename}`;
      let found: SkillFileRecord | null = null;
      try {
        found = await storage.readFile(spec.skillId, scriptPath);
      } catch (err) {
        if (err instanceof InvalidSkillPathError) {
          return { ok: false, error: `Invalid script path: ${filename}` };
        }
        throw err;
      }
      if (!found) {
        return { ok: false, error: `Script not found: ${scriptPath}` };
      }

      // 4. Delegate to the active sandbox adapter. Same enforcement
      //    envelope as run_code_in_sandbox.
      const adapter = await getActiveAdapter();
      const out = await adapter.run({
        command: [interpreter, "-"],
        stdin: found.content.toString("utf-8"),
        datasets: datasets ?? [],
      });
      return {
        stdout: out.stdout,
        stderr: out.stderr,
        exitCode: out.exitCode,
        durationMs: out.durationMs,
        ...(out.termination ? { termination: out.termination } : {}),
        backend: adapter.backend,
      };
    },
  });

  return {
    tools: [getSkill, getSkillFile, runSkillScript],
    promptBlock,
  };
}

// "Available Skills" block format mirrors Anthropic's published examples.
function renderPromptBlock(specs: SkillSpec[]): string {
  if (specs.length === 0) return "";
  const lines: string[] = [];
  lines.push("## Available Skills");
  lines.push(
    "When a user request matches one of these skills, call `get_skill(name)` to load its full instructions before acting.  Helper files inside a skill (references/, scripts/, assets/, evals/) are reachable via `get_skill_file(name, filename)`.  Scripts under `scripts/` can be executed with `run_skill_script(name, filename)` (V1: .py and .sh) — pass `datasets: [...]` for cached Parquet input at ./data/<name>/ in the sandbox cwd.",
  );
  lines.push("");
  for (const spec of specs) {
    const description: string = spec.description ?? "";
    lines.push(`- **${spec.name}**: ${description}`);
  }
  return lines.join("\n");
}

function isLikelyText(buf: Buffer): boolean {
  const slice: Buffer = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  return !slice.includes(0);
}
