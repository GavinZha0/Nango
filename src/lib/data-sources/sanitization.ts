/**
 * Utilities for sanitizing raw driver error messages and connection strings.
 */

import "server-only";

/**
 * Safely sanitizes database driver error messages for Agent consumption
 * by replacing raw connection failures with clean, actionable descriptions.
 */
export function sanitizeConnectionStringError(
  errorMessage: string,
  dataSourceName?: string,
): string {
  if (!errorMessage) return errorMessage;

  const dsLabel = dataSourceName ? ` "${dataSourceName}"` : "";

  // Check if the error represents an infrastructure connection failure
  const isConnectionFailure =
    /unable to connect|connection refused|could not translate host|connection failed|failed to connect|cannot connect/i.test(
      errorMessage,
    );

  if (isConnectionFailure) {
    // Extract DB provider if present (e.g. Postgres / MySQL / MariaDB / Vertica / SQLite)
    const providerMatch = errorMessage.match(/to\s+(Postgres|MySQL|MariaDB|Vertica|DuckDB|SQLite)\b/i);
    const dbType = providerMatch ? ` ${providerMatch[1]}` : "";
    return `IO Error: Unable to connect to${dbType} data source${dsLabel}`;
  }

  // Fallback sanitization for other non-connection errors that might still contain credentials or DSN params
  let sanitized = errorMessage;

  sanitized = sanitized.replace(
    /(?:at\s+["'])?(?:(?:host|port|dbname|database|user|password|pwd)=[^"'\s]+(?:\s+|$))+["']?/gi,
    dsLabel ? `at data source${dsLabel}` : "at data source",
  );

  sanitized = sanitized.replace(
    /\b([a-z0-9+.-]+):\/\/[^\s'"]+@[^\s'"]+/gi,
    (_match, scheme) => `${scheme}://[REDACTED_CREDENTIALS]`,
  );

  sanitized = sanitized.replace(/(password|pwd)=[^&\s'"]+/gi, "$1=******");

  return sanitized.replace(/\s+/g, " ").trim();
}

/**
 * Sanitizes errors for Admin UI data source testing:
 * Preserves host, port, dbname, user for admin debugging, but strictly masks any password/credentials.
 */
export function sanitizeAdminTestError(errorMessage: string): string {
  if (!errorMessage) return errorMessage;

  let sanitized = errorMessage;

  // Mask any password=... or pwd=... key-value pairs (handles both quoted and unquoted strings)
  sanitized = sanitized.replace(/(password|pwd)=[^"'\s&]+/gi, "$1=******");

  // Mask URL embedded credentials (e.g. postgres://user:secret@host)
  sanitized = sanitized.replace(
    /\b([a-z0-9+.-]+):\/\/[^:\s'"]+:([^@\s'"]+)@/gi,
    "$1://[user]:******@",
  );

  return sanitized.replace(/\s+/g, " ").trim();
}
