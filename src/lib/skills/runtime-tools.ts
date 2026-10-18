/**
 * Per-agent server-side skill tools: `get_skill`, `get_skill_file`,
 * `run_skill_script`, and `run_skill_script_on_ssh` (SSH-targeted scripts
 * declared in a skill's `scripts-on-ssh` frontmatter).
 *
 * See docs/skills.md and docs/ssh.md.
 */

import "server-only";

import { createHash } from "node:crypto";
import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import { z } from "zod";

import {
  getDbSkillStorage,
  InvalidSkillPathError,
  type SkillFileRecord,
} from "./storage";
import type { SkillSpec } from "./skill-pool";
import {
  describeUnusableSshScript,
  readSshScriptSource,
} from "./ssh-script-source";
import { getActiveAdapter } from "@/lib/sandbox/registry.server";
import { assembleCodeOutput } from "@/lib/sandbox/code-output";
import { shellSingleQuote } from "@/lib/ssh/client";
import {
  runOnBoundServer,
  SSH_SKILL_SCRIPT_MAX_COMMAND_CHARS,
} from "@/lib/ssh/runtime-tools";

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
  /**
   * True when the calling agent has at least one `ssh_server` bound, i.e. when
   * `run_skill_script_on_ssh` is mounted next to these tools. Drives routing
   * messages and the prompt annotation only — a `scripts-on-ssh` script is
   * never silently downgraded to the sandbox.
   */
  hasSshBindings?: boolean;
  /**
   * True when the calling agent has at least one data source bound, i.e. when
   * `run_skill_sql_script` is mounted next to these tools. Drives routing
   * messages and the prompt annotation only.
   */
  hasDbBindings?: boolean;
}

export interface SkillsRuntime {
  /** Tools to merge into `BuiltInAgent`'s `tools` array.  Empty if no skills. */
  tools: ToolDefinition[];
  /** Markdown block to append to the agent's prompt.  Empty when no skills. */
  promptBlock: string;
}

export function buildSkillsRuntime(args: BuildSkillsRuntimeArgs): SkillsRuntime {
  const { specs, hasSshBindings = false, hasDbBindings = false } = args;
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

  // Mirrors the mount condition in `runner/dispatch/builtin.ts`: the SSH
  // script tool exists only when a skill declares scripts AND a host is
  // bound. Prompt text and error hints must not advertise a tool that is
  // absent, or the model loops between two refusing tools.
  const sshToolAvailable: boolean =
    hasSshBindings && specs.some((spec) => spec.scriptsOnSsh.size > 0);
  const dbToolAvailable: boolean =
    hasDbBindings && specs.some((spec) => spec.scriptsOnDb.size > 0);

  const promptBlock: string = renderPromptBlock(
    specs,
    sshToolAvailable,
    dbToolAvailable,
  );
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
      "Read a helper file from a skill's tree.  Pass a bare filename to search the skill's folders by name, or a relative path like 'references/output-format.md' to target one directly.",
    parameters: z.object({
      name: z.string().describe("Skill name."),
      filename: z
        .string()
        .describe(
          "Bare filename (searched across the skill's folders by name) or a relative path such as 'lib/helper.py'.",
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
      // taken as-is. Without one, match by basename against the skill's
      // actual listing — folder names are author-defined, so there is no
      // fixed prefix list to enumerate. Sorted because listFiles has no
      // ORDER BY, so a duplicate basename would otherwise resolve by row
      // order. Validation rejects oversized / traversal / dotfile paths
      // up front so we never poke the DB with garbage.
      const candidates: string[] = filename.includes("/")
        ? [filename]
        : (await storage.listFiles(spec.skillId))
            .map((f) => f.path)
            .filter((p) => p.slice(p.lastIndexOf("/") + 1) === filename)
            .sort();

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
      "Execute a script bundled with a skill in the same sandbox as run_code_in_sandbox (no network, read-only rootfs, memory/CPU/timeout limits). Interpreter is picked from the file extension: .py → python3, .sh → bash. A bare filename is looked up under scripts/; a relative path must also live under scripts/ (subfolders such as 'scripts/lib/analyze.py' are allowed). Executable scripts outside scripts/ are refused. Pass `datasets` to expose cached Parquet datasets read-only at ./tmp/data/<name>/ in the sandbox cwd — same convention as run_code_in_sandbox. Returns CodeOutputEnvelope { ok, duration_ms, rows, row_count, row_schema, message, files, error } plus backend. Scripts listed in the skill's scripts-on-ssh frontmatter run on a remote host with run_skill_script_on_ssh and are refused here.",
    parameters: z.object({
      name: z.string().describe("Skill name."),
      filename: z
        .string()
        .describe(
          "Script filename, e.g. 'analyze.py' (looked up under scripts/) or a relative path such as 'bin/analyze.py'.",
        ),
      datasets: z
        .array(z.string())
        .optional()
        .describe(
          "Cached dataset names (from extract_dataset_by_sql) to expose read-only at ./tmp/data/<name>/ in the sandbox cwd.",
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

      // 2. Normalize script path. A path with a separator is taken as-is so
      //    authors who keep executables in `bin/`, `lib/`, … can run them;
      //    a bare name still defaults to scripts/. The extension gate below
      //    (not the folder) is what keeps non-executables out of the sandbox.
      const scriptPath: string = filename.includes("/")
        ? filename
        : `scripts/${filename}`;

      if (!scriptPath.startsWith("scripts/")) {
        return {
          ok: false,
          error: "SCRIPT_OUTSIDE_SCRIPTS",
          message:
            `'${filename}' must live under scripts/. Executable scripts are ` +
            "restricted to the scripts/ folder (subfolders are allowed).",
        };
      }

      // Routing check: scripts listed in scripts-on-ssh target remote hosts,
      // so the sandbox never runs them — executing e.g. a probe script locally
      // would report the sandbox instead of the intended host and hand back
      // confidently wrong data. When no host is bound the SSH tool itself is
      // absent, so the message has to name the unblock action instead.
      if (spec.scriptsOnSsh.has(scriptPath)) {
        return sshToolAvailable
          ? {
              ok: false,
              error: "SSH_SCRIPT",
              message: `'${scriptPath}' is declared in scripts-on-ssh; use run_skill_script_on_ssh instead.`,
            }
          : {
              ok: false,
              error: "SSH_NOT_AVAILABLE",
              message:
                `'${scriptPath}' is declared in scripts-on-ssh, but this agent has no ssh_server bound, ` +
                "so run_skill_script_on_ssh is unavailable. Bind an SSH host to this agent and retry — " +
                "the script is not executed in the sandbox because it targets remote hosts.",
            };
      }

      // 3. Pick interpreter from extension before we touch the DB.
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

      // 4. Resolve script bytes from DB.
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

      // 5. Delegate to the active sandbox adapter. Same enforcement
      //    envelope as run_code_in_sandbox.
      const adapter = await getActiveAdapter();
      const out = await adapter.run({
        command: [interpreter, "-"],
        stdin: found.content.toString("utf-8"),
        datasets: datasets ?? [],
      });
      return {
        ...assembleCodeOutput(out),
        backend: adapter.backend,
      };
    },
  });

  return {
    tools: [getSkill, getSkillFile, runSkillScript],
    promptBlock,
  };
}

const RunSkillScriptOnSshArgs = z.object({
  name: z.string().min(1).describe("Skill name."),
  filename: z
    .string()
    .min(1)
    .describe(
      "Script listed in the skill's scripts-on-ssh, e.g. 'probe.sh', 'scripts/probe.sh', or 'scripts/lib/probe.sh'.",
    ),
  serverName: z
    .string()
    .min(1)
    .describe("Slug of a bound SSH server (see list_ssh_hosts)."),
  args: z
    .array(z.string().max(4096))
    .max(64)
    .optional()
    .describe(
      "Positional arguments: $1, $2, ... for .sh; sys.argv[1:] for .py.",
    ),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "Wall-clock timeout in SECONDS (1-300). NOT milliseconds. Default 30.",
    ),
});

export interface BuildRunSkillScriptOnSshToolOpts {
  specs: SkillSpec[];
  agentSshServerIds: readonly string[];
}

/**
 * Build the `run_skill_script_on_ssh` tool definition.
 *
 * Executes reviewed script bytes from a skill on a bound SSH server.
 * Both the skill and the SSH server must be bound to the caller agent.
 * The script must be explicitly declared in the skill's `scripts-on-ssh`
 * frontmatter.
 */
export function buildRunSkillScriptOnSshTool(
  opts: BuildRunSkillScriptOnSshToolOpts,
): ToolDefinition {
  const byName: Map<string, SkillSpec> = new Map();
  for (const spec of opts.specs) {
    if (!byName.has(spec.name)) byName.set(spec.name, spec);
  }
  const storage = getDbSkillStorage();

  return defineTool({
    name: "run_skill_script_on_ssh",
    description:
      "Execute a reviewed skill script on a bound SSH host. The script must be " +
      "declared in the skill's scripts-on-ssh frontmatter. Pass `name` (skill name), " +
      "`filename` (e.g. 'probe.sh'), `serverName` (SSH server slug from list_ssh_hosts), " +
      "and optional `args` (positional arguments: $1, $2, ... for .sh; sys.argv[1:] for .py) " +
      "and `timeoutSeconds` (1-300 seconds, default 30). Returns { ok, serverName, host, " +
      "skill, script, scriptSha256, stdout, stderr, exitCode, signal, durationMs, truncated }.",
    parameters: RunSkillScriptOnSshArgs,
    execute: async (rawArgs, ctx?: { abortSignal?: AbortSignal }) => {
      const args = RunSkillScriptOnSshArgs.parse(rawArgs);

      // Step 1: Resolve skill (must be bound to this agent).
      const spec: SkillSpec | undefined = byName.get(args.name);
      if (!spec) {
        return {
          ok: false,
          error: "SKILL_NOT_FOUND",
          message: `No skill named "${args.name}" is available to this agent.`,
          available: [...byName.keys()],
        };
      }

      // Step 2: Normalize script path.
      const scriptPath: string = args.filename.startsWith("scripts/")
        ? args.filename
        : `scripts/${args.filename}`;

      // Step 3: Check membership in scripts-on-ssh.
      if (!spec.scriptsOnSsh.has(scriptPath)) {
        return {
          ok: false,
          error: "NOT_AN_SSH_SCRIPT",
          message:
            `'${scriptPath}' is not declared in scripts-on-ssh for skill '${args.name}'. ` +
            `Use run_skill_script for sandbox scripts.`,
        };
      }

      // Step 4: Pick interpreter.
      const interpreter: string | null = pickInterpreter(scriptPath);
      if (!interpreter) {
        return {
          ok: false,
          error: "UNSUPPORTED_INTERPRETER",
          message: `Unsupported script extension on '${scriptPath}'. Supported: .py, .sh.`,
        };
      }

      // Step 5: Resolve script bytes from DB.
      let found: SkillFileRecord | null = null;
      try {
        found = await storage.readFile(spec.skillId, scriptPath);
      } catch (err) {
        if (err instanceof InvalidSkillPathError) {
          return {
            ok: false,
            error: "SCRIPT_NOT_FOUND",
            message: `Invalid script path: ${args.filename}`,
          };
        }
        throw err;
      }
      if (!found) {
        return {
          ok: false,
          error: "SCRIPT_NOT_FOUND",
          message: `Script '${scriptPath}' not found in skill '${args.name}'.`,
        };
      }

      // Step 6: Strict UTF-8 decode + NUL check.
      const decoded = readSshScriptSource(found.content);
      if (!decoded.ok) {
        return {
          ok: false,
          error: "INVALID_SCRIPT_BYTES",
          message: describeUnusableSshScript(scriptPath, decoded.reason),
        };
      }
      const scriptText: string = decoded.text;

      // Step 7: Command assembly.
      // bash: bash -c '<script>' '<skillName>' '<arg1>' '<arg2>' ...
      // python: python3 -c '<script>' '<arg1>' '<arg2>' ...
      const quotedScript = shellSingleQuote(scriptText);
      const quotedArgs = (args.args ?? []).map(shellSingleQuote).join(" ");
      const command =
        interpreter === "bash"
          ? `bash -c ${quotedScript} ${shellSingleQuote(spec.name)}${quotedArgs ? " " + quotedArgs : ""}`
          : `python3 -c ${quotedScript}${quotedArgs ? " " + quotedArgs : ""}`;

      // Step 8: Delegate to runOnBoundServer, which owns the length gate on
      // the composed wire command (a login-shell host re-quotes `command`,
      // so measuring it here would under-report).
      const execResult = await runOnBoundServer({
        serverName: args.serverName,
        command,
        timeoutSeconds: args.timeoutSeconds,
        maxCommandChars: SSH_SKILL_SCRIPT_MAX_COMMAND_CHARS,
        agentSshServerIds: opts.agentSshServerIds,
        signal: ctx?.abortSignal,
      });

      if (!execResult.ok) {
        return execResult;
      }

      const scriptSha256 = createHash("sha256")
        .update(found.content)
        .digest("hex");

      return {
        ok: true,
        skill: spec.name,
        script: scriptPath,
        scriptSha256,
        serverName: execResult.serverName,
        host: execResult.host,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        exitCode: execResult.exitCode,
        signal: execResult.signal,
        durationMs: execResult.durationMs,
        truncated: execResult.truncated,
      };
    },
  });
}

// "Available Skills" block format mirrors Anthropic's published examples.
function renderPromptBlock(
  specs: SkillSpec[],
  sshToolAvailable: boolean,
  dbToolAvailable: boolean,
): string {
  if (specs.length === 0) return "";
  const lines: string[] = [];
  lines.push("## Available Skills");
  lines.push(
    "When a user request matches one of these skills, call `get_skill(name)` to load its full instructions before acting.  Helper files inside a skill live in author-defined folders (commonly references/, scripts/, assets/, evals/) and are reachable via `get_skill_file(name, filename)`.  Scripts (.py and .sh) can be executed with `run_skill_script(name, filename)` — pass `datasets: [...]` for cached Parquet input at ./tmp/data/<name>/ in the sandbox cwd." +
      // Only name a tool when it is actually mounted; otherwise the model
      // would be instructed to call a tool that does not exist.
      (sshToolAvailable
        ? " Scripts listed in `scripts-on-ssh` must use `run_skill_script_on_ssh(name, filename, serverName)` instead."
        : "") +
      (dbToolAvailable
        ? " SQL files listed in `scripts-on-db` must use `run_skill_sql_script(name, filename, dataSourceName, datasetName)`. For ad-hoc or modified SQL, use `extract_dataset_by_sql`."
        : ""),
  );
  lines.push("");
  for (const spec of specs) {
    const description: string = spec.description ?? "";
    const sshNote =
      spec.scriptsOnSsh.size > 0
        ? ` (SSH scripts: ${[...spec.scriptsOnSsh]
            .map((p) => p.replace(/^scripts\//, ""))
            .join(", ")}${
            sshToolAvailable
              ? ""
              : " — require an SSH host bound to this agent; not runnable"
          })`
        : "";
    const dbNote =
      spec.scriptsOnDb.size > 0
        ? ` (DB scripts: ${[...spec.scriptsOnDb]
            .map((p) => p.replace(/^scripts\//, ""))
            .join(", ")}${
            dbToolAvailable
              ? ""
              : " — require a data source bound to this agent; not runnable"
          })`
        : "";
    lines.push(`- **${spec.name}**${sshNote}${dbNote}: ${description}`);
  }
  return lines.join("\n");
}

function isLikelyText(buf: Buffer): boolean {
  const slice: Buffer = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  return !slice.includes(0);
}
