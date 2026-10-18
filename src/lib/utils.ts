import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Structural deep equality comparison that ignores object key insertion order.
 * Safe against PostgreSQL jsonb key re-ordering in client-side dirty state detection.
 */
export function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!isDeepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Format character count for concise metrics display (e.g. 640c, 1.3k).
 */
export function formatCharCount(chars: number): string {
  if (chars >= 1000) {
    return `${(Math.round(chars / 100) / 10).toFixed(1)}k`;
  }
  return `${chars}c`;
}

/**
 * Format a byte count for concise metrics display (e.g. 842 B, 12.4 KB).
 * Stops at MB because the skill caps are 256 KB per file and 10 MB per skill.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
