/**
 * `run_skill_sql_script` — execute a reviewed SQL file declared in a skill's
 * `scripts-on-db` frontmatter against a bound data source.
 *
 * The tool is a skill-side façade over `extractDatasetForAgent`; it never
 * accepts raw SQL from the model.
 *
 * See docs/skills.md and docs/data-sources.md.
 */

import "server-only";

import { createHash } from "node:crypto";
import { defineTool } from "@/lib/copilot/index.server";
import type { ToolDefinition } from "@/lib/copilot/index.server";
import { z } from "zod";

import { extractDatasetForAgent } from "@/lib/data-sources/runtime-tools";
import { getExtension } from "./file-rules";
import { readTextScriptSource } from "./ssh-script-source";
import type { SkillSpec } from "./skill-pool";
import {
  getDbSkillStorage,
  InvalidSkillPathError,
  type SkillFileRecord,
} from "./storage";

const RunSkillSqlScriptArgs = z.object({
  name: z.string().min(1).describe("Skill name."),
  filename: z
    .string()
    .min(1)
    .describe(
      "SQL file listed in scripts-on-db, e.g. 'reports/sales.sql' or 'scripts/reports/sales.sql'.",
    ),
  dataSourceName: z
    .string()
    .min(1)
    .describe("Slug of a bound data source (see the 'Available data sources' block)."),
  datasetName: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Parquet cache slot for the result; same semantics as extract_dataset_by_sql.dataset_name.",
    ),
  rowLimit: z
    .number()
    .int()
    .min(0)
    .max(200)
    .optional()
    .describe("Rows to return inline; defaults to the data-source preview default."),
  forceRefresh: z
    .boolean()
    .optional()
    .describe("Bypass the cache and re-extract from the data source."),
});

export interface BuildRunSkillSqlScriptToolOpts {
  specs: SkillSpec[];
  agentDataSourceIds: readonly string[];
}

/**
 * Build the `run_skill_sql_script` tool definition.
 *
 * Mounted only when at least one bound skill declares a DB script AND the
 * agent has at least one data source binding.
 */
export function buildRunSkillSqlScriptTool(
  opts: BuildRunSkillSqlScriptToolOpts,
): ToolDefinition {
  const byName = new Map<string, SkillSpec>();
  for (const spec of opts.specs) {
    if (!byName.has(spec.name)) byName.set(spec.name, spec);
  }
  const storage = getDbSkillStorage();

  return defineTool({
    name: "run_skill_sql_script",
    description:
      "Execute a reviewed SQL file declared in the skill's scripts-on-db " +
      "against a bound data source, materialising the result as a Parquet " +
      "dataset (same cache semantics as extract_dataset_by_sql). It does " +
      "NOT accept raw SQL: for ad-hoc, modified, or parameterised SQL use " +
      "extract_dataset_by_sql instead. SQL files must be single SELECT/WITH " +
      "statements; bound parameters are not supported. Returns " +
      "{ ok, skill, script, scriptSha256, dataSourceName, cache_hit, " +
      "dataset_name, total_rows, returned_rows, rows, row_schema, " +
      "ttl_hours, replaced_prior? }.",
    parameters: RunSkillSqlScriptArgs,
    execute: async (rawArgs) => {
      const args = RunSkillSqlScriptArgs.parse(rawArgs);

      const spec = byName.get(args.name);
      if (!spec) {
        return {
          ok: false,
          error: "SKILL_NOT_FOUND",
          message: `No skill named "${args.name}" is available to this agent.`,
          available: [...byName.keys()],
        };
      }

      const scriptPath = args.filename.startsWith("scripts/")
        ? args.filename
        : `scripts/${args.filename}`;

      if (!spec.scriptsOnDb.has(scriptPath)) {
        return {
          ok: false,
          error: "NOT_A_DB_SCRIPT",
          message:
            `'${scriptPath}' is not declared in scripts-on-db for skill ` +
            `'${args.name}'. Use extract_dataset_by_sql for ad-hoc SQL.`,
        };
      }
      if (getExtension(scriptPath) !== "sql") {
        return {
          ok: false,
          error: "UNSUPPORTED_EXTENSION",
          message: `'${scriptPath}' must have a .sql extension.`,
        };
      }

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
          message: `SQL file '${scriptPath}' not found in skill '${args.name}'.`,
        };
      }

      const decoded = readTextScriptSource(found.content);
      if (!decoded.ok) {
        return {
          ok: false,
          error: "INVALID_SCRIPT_BYTES",
          message:
            `${scriptPath} is not valid UTF-8 or contains NUL bytes; ` +
            "fix the file before declaring it in scripts-on-db.",
        };
      }
      const sqlText = decoded.text.trim();
      if (sqlText.length === 0) {
        return {
          ok: false,
          error: "EMPTY_SQL",
          message: `SQL file '${scriptPath}' is empty.`,
        };
      }

      const result = await extractDatasetForAgent(
        {
          dataSourceName: args.dataSourceName,
          datasetName: args.datasetName,
          sqlText,
          rowLimit: args.rowLimit,
          forceRefresh: args.forceRefresh,
        },
        opts.agentDataSourceIds,
      );

      if ("error" in result) {
        return {
          ok: false,
          error: result.error.code,
          message: result.error.message,
        };
      }

      const scriptSha256 = createHash("sha256")
        .update(found.content)
        .digest("hex");

      return {
        ok: true,
        skill: spec.name,
        script: scriptPath,
        scriptSha256,
        dataSourceName: args.dataSourceName,
        ...result,
      };
    },
  });
}
