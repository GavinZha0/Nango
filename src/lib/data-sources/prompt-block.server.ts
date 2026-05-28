/**
 * Build the "Available data sources" system-prompt block for an
 */

import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { DataSourceTable } from "@/lib/db/schema";

export interface DataSourcePromptBlock {
  /** The block itself, ready to concatenate into the system prompt
   *  with a leading newline; empty string when no usable sources are
   *  bound (caller should skip the concatenation entirely). */
  promptBlock: string;
}

/**
 * Build the prompt block from a set of data_source ids. Resolves
 * + filters in one DB read; safe to call once per dispatch.
 */
export async function buildDataSourcesPromptBlock(
  dataSourceIds: readonly string[],
): Promise<DataSourcePromptBlock> {
  if (dataSourceIds.length === 0) return { promptBlock: "" };

  const rows = await db
    .select({
      name: DataSourceTable.name,
      description: DataSourceTable.description,
      provider: DataSourceTable.provider,
    })
    .from(DataSourceTable)
    .where(
      and(
        inArray(DataSourceTable.id, [...dataSourceIds]),
        // Honour the enabled flag at injection time — admin can pull
        // a source out of agent context without breaking other
        // bindings. Cache invalidation in the credentials hook
        // refreshes specs when this flips.
        eq(DataSourceTable.enabled, true),
      ),
    )
    .orderBy(DataSourceTable.name);

  if (rows.length === 0) return { promptBlock: "" };

  const lines = rows.map((r) => {
    const desc = r.description ? ` — ${r.description}` : "";
    return `  - ${r.name} (${r.provider})${desc}`;
  });

  const intro =
    "Available data sources (pass the slug as `dataSourceName` to " +
    "extract_dataset_by_sql; provider in parentheses tells you which " +
    "SQL dialect to use). The sandbox NEVER has direct database " +
    "access — to read data you MUST first call extract_dataset_by_sql " +
    "(materialises a Parquet snapshot), then pass the same `name` as " +
    "`datasets[]` to run_code_in_sandbox; the file becomes available " +
    "at ./data/<name>/ in the sandbox's current working directory. Do NOT attempt to `import duckdb` or any " +
    "other DB driver inside the sandbox — there are no credentials there.\n\n" +
    "Cross-schema queries: for mysql / mariadb / postgres sources, if a " +
    "query against an unqualified table name returns a 'Catalog Error' or " +
    "'Did you mean ...' hint, the table lives in a different schema/database " +
    "than the data source's default. Retry with a schema-qualified name " +
    "(`<schema>.<table>` for mysql/mariadb, `<schema>.<table>` for postgres) " +
    "exactly as suggested by the error — do NOT include the `src.` ATTACH " +
    "alias prefix.";
  return { promptBlock: `${intro}\n${lines.join("\n")}` };
}
