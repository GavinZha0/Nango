import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { SkillTable } from "@/lib/db/schema";
import { canViewResource } from "@/lib/auth/permissions";
import { ApiError, withSession } from "@/lib/http/route-handlers";
import {
  getDbSkillStorage,
  InvalidSkillPathError,
  type SkillFileRecord,
} from "@/lib/skills/storage";

const ROUTE = "/api/skills/[id]/files/[...path]";

/**
 * GET /api/skills/[id]/files/[...path]
 */
export const GET = withSession<{ id: string; path: string[] }>(
  ROUTE,
  async ({ params, session }) => {
    const [row] = await db
      .select({
        id: SkillTable.id,
        source: SkillTable.source,
        visibility: SkillTable.visibility,
        createdBy: SkillTable.createdBy,
      })
      .from(SkillTable)
      .where(eq(SkillTable.id, params.id))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", 404, "Skill not found.");
    // SECURITY: same predicate the skill-detail route uses. A hand-rolled
    // `visibility === 'public' || createdBy === me` check omits the admin
    // exception, which would let an admin list a private skill's files and
    // then 404 on every one of them.
    if (
      !canViewResource(
        {
          source: row.source as "builtin" | "local",
          visibility: row.visibility as "private" | "public",
          createdBy: row.createdBy,
        },
        session,
      )
    ) {
      throw new ApiError("NOT_FOUND", 404, "Skill not found.");
    }

    const filename: string = (params.path ?? []).join("/");
    if (filename.length === 0) {
      throw new ApiError("BAD_REQUEST", 400, "Missing filename.");
    }

    const storage = getDbSkillStorage();
    // A bare filename is resolved against the skill's actual listing rather
    // than a fixed prefix list: authors name their folders freely, so the
    // archive layout is the only source of truth. Sorted so a duplicate
    // basename resolves deterministically instead of by DB row order.
    const candidates: string[] = filename.includes("/")
      ? [filename]
      : (await storage.listFiles(row.id))
          .map((f) => f.path)
          .filter((p) => p.slice(p.lastIndexOf("/") + 1) === filename)
          .sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
          );

    let found: SkillFileRecord | null = null;
    for (const candidate of candidates) {
      try {
        const rec = await storage.readFile(row.id, candidate);
        if (rec) {
          found = rec;
          break;
        }
      } catch (err) {
        if (err instanceof InvalidSkillPathError) {
          throw new ApiError("BAD_REQUEST", 400, err.message);
        }
        throw err;
      }
    }
    if (!found) {
      throw new ApiError("NOT_FOUND", 404, `File not found: ${filename}`);
    }

    const isText: boolean = isLikelyText(found.content);
    return NextResponse.json({
      path: found.path,
      encoding: isText ? "utf8" : "base64",
      content: isText
        ? found.content.toString("utf8")
        : found.content.toString("base64"),
      size: found.size,
    });
  },
);

function isLikelyText(buf: Buffer): boolean {
  const slice: Buffer = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  return !slice.includes(0);
}
