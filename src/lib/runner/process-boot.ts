/**
 * Record one row per Node process boot and cache the result.
 *
 * @see docs/orchestrator.md#11-implementation-details-and-quirks
 */

import "server-only";

import os from "node:os";

import { db } from "@/lib/db";
import { ProcessBootTable } from "@/lib/db/schema";
import { childLogger } from "@/lib/observability/logger";

const log = childLogger({ component: "process-boot" });

export interface ProcessBootRecord {
  id: number;
  startedAt: Date;
}

const GLOBAL_KEY = Symbol.for("nango.runner.processBoot");
type Holder = { [k: symbol]: ProcessBootRecord | undefined };
const holder = globalThis as Holder;

/** Insert one process_boot row and cache (id, startedAt) for the
 *  rest of this Node process's lifetime. CONTRACT: idempotent —
 *  re-invocations return the cached record without touching the DB. */
export async function recordProcessBoot(): Promise<ProcessBootRecord> {
  const cached = holder[GLOBAL_KEY];
  if (cached) return cached;

  const [row] = await db
    .insert(ProcessBootTable)
    .values({
      hostname: os.hostname(),
      pid: process.pid,
    })
    .returning({
      id: ProcessBootTable.id,
      startedAt: ProcessBootTable.startedAt,
    });

  const record: ProcessBootRecord = {
    id: row.id,
    startedAt: row.startedAt,
  };
  holder[GLOBAL_KEY] = record;

  log.info(
    {
      event: "process_boot_recorded",
      bootId: record.id,
      startedAt: record.startedAt.toISOString(),
      hostname: os.hostname(),
      pid: process.pid,
    },
    "process boot recorded",
  );

  return record;
}

/** For tests / introspection. Returns the cached record without
 *  inserting if `recordProcessBoot` hasn't run yet. */
export function getCachedProcessBoot(): ProcessBootRecord | undefined {
  return holder[GLOBAL_KEY];
}
