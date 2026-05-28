/**
 * GET  /api/admin/config — list all config, grouped by key prefix.
 * POST /api/admin/config — create a custom config key.
 */

import "server-only";

import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { ConfigTable, CONFIG_VALUE_TYPES } from "@/lib/db/schema";
import { ApiError, withAdmin } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { createConfig, CONFIG_DEFAULTS_MAP } from "@/lib/config";

const ROUTE = "/api/admin/config";

// GET — list all config rows, ordered by key.

export const GET = withAdmin(ROUTE, async () => {
  const rows = await db
    .select()
    .from(ConfigTable)
    .orderBy(asc(ConfigTable.key));

  // Group by first key segment for UI rendering.
  const groups: Record<string, typeof rows> = {};
  for (const row of rows) {
    const group = row.key.split(".")[0] ?? "other";
    (groups[group] ??= []).push(row);
  }

  return NextResponse.json({ items: rows, groups });
});

// POST — create a new custom config key.

const createSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.]*$/, "Key must be lowercase dot-notation"),
    value: z.string(),
    valueType: z.enum(CONFIG_VALUE_TYPES).default("string"),
    description: z.string().max(500).optional(),
  })
  .strict();

export const POST = withAdmin(ROUTE, async ({ req, session }) => {
  const body = await parseBody(req, createSchema);

  if (CONFIG_DEFAULTS_MAP.has(body.key)) {
    throw new ApiError(
      "CONFLICT",
      409,
      `Key "${body.key}" is a predefined config. Use PATCH to update it.`,
    );
  }

  const id = await createConfig({
    key: body.key,
    value: body.value,
    valueType: body.valueType,
    description: body.description,
    updatedBy: session.user.id,
  });

  return NextResponse.json({ id, key: body.key }, { status: 201 });
});
