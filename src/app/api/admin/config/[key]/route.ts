/**
 * GET    /api/admin/config/:key — read a single config.
 * PATCH  /api/admin/config/:key — update a config value.
 * DELETE /api/admin/config/:key — delete a custom config key.
 */

import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { ConfigTable } from "@/lib/db/schema";
import { ApiError, withAdmin } from "@/lib/http/route-handlers";
import { parseBody } from "@/lib/http/validation";
import { updateConfig, deleteConfig, CONFIG_DEFAULTS_MAP } from "@/lib/config";

const ROUTE = "/api/admin/config/[key]";

type Params = { key: string };

// GET — read single config row.

export const GET = withAdmin<Params>(ROUTE, async ({ params }) => {
  const { key } = await params;

  const [row] = await db
    .select()
    .from(ConfigTable)
    .where(eq(ConfigTable.key, key))
    .limit(1);

  if (!row) {
    throw new ApiError("NOT_FOUND", 404, `Config key not found: ${key}`);
  }

  const isPredefined = CONFIG_DEFAULTS_MAP.has(key);
  return NextResponse.json({ ...row, predefined: isPredefined });
});

// PATCH — update value.

const updateSchema = z
  .object({
    value: z.string(),
    description: z.string().max(500).optional(),
  })
  .strict();

export const PATCH = withAdmin<Params>(ROUTE, async ({ req, params, session }) => {
  const { key } = await params;
  const body = await parseBody(req, updateSchema);

  try {
    await updateConfig({
      key,
      value: body.value,
      updatedBy: session.user.id,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      throw new ApiError("NOT_FOUND", 404, err.message);
    }
    throw err;
  }

  // Also update description if provided.
  if (body.description !== undefined) {
    await db
      .update(ConfigTable)
      .set({ description: body.description })
      .where(eq(ConfigTable.key, key));
  }

  const [row] = await db
    .select()
    .from(ConfigTable)
    .where(eq(ConfigTable.key, key))
    .limit(1);

  return NextResponse.json(row);
});

// DELETE — remove custom config key (predefined keys cannot be deleted).

export const DELETE = withAdmin<Params>(ROUTE, async ({ params }) => {
  const { key } = await params;

  try {
    const deleted = await deleteConfig(key);
    if (!deleted) {
      throw new ApiError("NOT_FOUND", 404, `Config key not found: ${key}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("predefined")) {
      throw new ApiError("BAD_REQUEST", 400, err.message);
    }
    if (err instanceof ApiError) throw err;
    throw err;
  }

  return new NextResponse(null, { status: 204 });
});
