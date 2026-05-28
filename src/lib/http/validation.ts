import "server-only";

import { z, type ZodType, type ZodError } from "zod";

import { ApiError } from "@/lib/http/route-handlers";

/**
 * Parse and validate a JSON request body against a Zod schema.
 * Throws {@link ApiError} on failure (invalid JSON or schema mismatch).
 */
export async function parseBody<T>(
  req: Request,
  schema: ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError("BAD_REQUEST", 400, "Invalid JSON in request body.");
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError(
      "VALIDATION_FAILED",
      400,
      "Request body validation failed.",
      { issues: formatIssues(result.error) },
    );
  }

  return result.data;
}

function formatIssues(error: ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
    code: i.code,
  }));
}

// Common reusable schemas

/** Trim a string and reject empty values. */
export const nonEmptyString = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "must not be empty"));

/** Trim a string; coerce empty strings to null. */
export const optionalTrimmedString = z
  .union([z.string(), z.null()])
  .transform((s) => {
    if (s === null) return null;
    const t = s.trim();
    return t.length === 0 ? null : t;
  });

export const uuidString = z.string().uuid();
