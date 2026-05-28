/**
 * Client-safe helpers for the standard `{ ok:false, code, message, requestId, details? }`
 */

export interface ApiErrorEnvelope {
  ok: false;
  code: string;
  message: string;
  requestId?: string;
  details?: {
    issues?: Array<{ path: string; message: string; code?: string }>;
    [key: string]: unknown;
  };
}

/**
 * Build a human-readable message from an envelope, expanding Zod issue lists
 * (`VALIDATION_FAILED` / `details.issues`) so users see *why* the call failed
 * instead of the generic "Request body validation failed."
 */
export function formatApiError(envelope: ApiErrorEnvelope | null | undefined): string {
  if (!envelope) return "Request failed";
  const issues = envelope.details?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const lines = issues.map((i) => {
      const path = i.path && i.path.length > 0 ? i.path : "(root)";
      return `${path}: ${i.message}`;
    });
    return `${envelope.message}\n${lines.join("\n")}`;
  }
  return envelope.message || envelope.code || "Request failed";
}

/**
 * Read a non-OK `Response` and return a formatted message.
 * Falls back to legacy `{ error }` shape and the HTTP status text if neither
 * envelope is present (e.g. an upstream reverse-proxy 5xx).
 */
export async function readApiError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as
      | (ApiErrorEnvelope & { error?: string })
      | { error?: string; message?: string };
    if (data && typeof data === "object") {
      if ("ok" in data && data.ok === false) {
        return formatApiError(data as ApiErrorEnvelope);
      }
      const legacy = (data as { message?: string; error?: string }).message
        ?? (data as { error?: string }).error;
      if (legacy) return legacy;
    }
  } catch {
    // not JSON — fall through
  }
  return `${res.status} ${res.statusText || "Request failed"}`;
}
