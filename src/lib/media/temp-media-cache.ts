import "server-only";

interface CachedMedia {
  buffer: Buffer;
  mimeType: string;
  createdAt: number;
}

const MAX_ITEMS = 100;
const mediaCache = new Map<string, CachedMedia>();

/**
 * Store media in temporary memory cache.
 */
export function setTempMedia(
  id: string,
  data: Buffer | string,
  mimeType = "image/png",
): void {
  const buffer = typeof data === "string" ? Buffer.from(data, "base64") : data;

  if (mediaCache.size >= MAX_ITEMS) {
    const oldestKey = mediaCache.keys().next().value;
    if (oldestKey) {
      mediaCache.delete(oldestKey);
    }
  }

  mediaCache.set(id, {
    buffer,
    mimeType,
    createdAt: Date.now(),
  });
}

/**
 * Get media from temporary memory cache.
 */
export function getTempMedia(
  id: string,
): { buffer: Buffer; mimeType: string } | null {
  const item = mediaCache.get(id);
  if (!item) return null;
  return { buffer: item.buffer, mimeType: item.mimeType };
}
