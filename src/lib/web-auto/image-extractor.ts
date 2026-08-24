/**
 * Web Auto Image Extractor & Output Sanitizer.
 *
 * Extracts screenshot/snapshot image payloads from Playwright MCP
 * execution outputs, and formats output JSON for display with truncated
 * Base64 previews.
 */

export interface WebAutoExtractedImage {
  id: string;
  name: string;
  src: string;
  rawBase64: string;
  filename?: string;
  format: "png" | "jpeg" | "webp" | "image";
  sizeKB: number;
}

const PRIORITY_KEYS = [
  "snapshot",
  "snapshots",
  "screenshot",
  "screenshots",
  "image",
  "images",
] as const;

const IMAGE_EXT_REGEX = /\.(png|jpe?g|webp|gif|svg)$/i;

/** Strip relative/container path tokens to obtain the clean base filename */
function sanitizeFilename(raw: string): string {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^['"]|['"]$/g, "");
  cleaned = cleaned.replace(/\\/g, "/");
  cleaned = cleaned.replace(/^(\.\/|\/app\/\.output\/|\.playwright-mcp\/)/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || cleaned;
}

/** Detect format from MIME type, data URI prefix, or filename extension */
function detectImageFormat(dataUriOrMimeOrFilename: string): "png" | "jpeg" | "webp" | "image" {
  const lower = dataUriOrMimeOrFilename.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpeg";
  if (lower.includes("webp")) return "webp";
  return "image";
}

/** Check if a string is a standard data:image URI */
function isDataImageUri(val: string): boolean {
  return /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(val);
}

/** Extract base64 payload or filename image payload */
function parseImageString(
  raw: string,
  name: string,
  index: number,
): WebAutoExtractedImage | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();

  // 1. Full data URI format: data:image/png;base64,...
  if (isDataImageUri(trimmed)) {
    const match = trimmed.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/i);
    if (match && match[1] && match[2]) {
      const mime = match[1];
      const rawBase64 = match[2];
      const format = detectImageFormat(mime);
      const sizeKB = Math.round((rawBase64.length * 0.75) / 1024);
      return {
        id: `img-${name}-${index}`,
        name,
        src: trimmed,
        rawBase64,
        format,
        sizeKB,
      };
    }
  }

  // 2. Pure base64 fallback (heuristic: length > 100, no spaces, alphanumeric/base64 charset)
  if (
    trimmed.length > 100 &&
    !trimmed.includes(" ") &&
    /^[A-Za-z0-9+/=]+$/.test(trimmed)
  ) {
    const rawBase64 = trimmed;
    const format = "png";
    const sizeKB = Math.round((rawBase64.length * 0.75) / 1024);
    return {
      id: `img-${name}-${index}`,
      name,
      src: `data:image/png;base64,${rawBase64}`,
      rawBase64,
      format,
      sizeKB,
    };
  }

  // 3. Direct filename or file path (e.g. "githubhome.png", "./screenshot.webp", "/app/.output/dashboard.jpeg")
  if (IMAGE_EXT_REGEX.test(trimmed) && trimmed.length < 500) {
    const clean = sanitizeFilename(trimmed);
    if (clean && clean !== "." && clean !== "..") {
      const format = detectImageFormat(clean);
      return {
        id: `img-${name}-${index}`,
        name,
        filename: clean,
        src: `/api/media/playwright-files?file=${encodeURIComponent(clean)}`,
        rawBase64: "",
        format,
        sizeKB: 0,
      };
    }
  }

  return null;
}

/**
 * Extract all screenshot and snapshot images from Playwright MCP output.
 * Scans result property or top-level output, prioritizing standard
 * screenshot/snapshot/image keys, with fallback recursive scan.
 */
export function extractWebAutoImages(output: unknown): WebAutoExtractedImage[] {
  if (!output || typeof output !== "object") {
    // If string output, try parsing JSON
    if (typeof output === "string") {
      try {
        const parsed = JSON.parse(output) as unknown;
        if (parsed && typeof parsed === "object") {
          return extractWebAutoImages(parsed);
        }
      } catch {
        return [];
      }
    }
    return [];
  }

  const images: WebAutoExtractedImage[] = [];
  const visited = new Set<string>();

  // Target scanning container: prioritize executionOutput.result if available
  const outputObj = output as Record<string, unknown>;
  const targets: Array<{ label: string; obj: Record<string, unknown> }> = [];

  if (outputObj.result && typeof outputObj.result === "object" && outputObj.result !== null) {
    targets.push({ label: "result", obj: outputObj.result as Record<string, unknown> });
  }
  targets.push({ label: "root", obj: outputObj });

  // 1. Priority key scan
  for (const { obj } of targets) {
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      if (PRIORITY_KEYS.some((pk) => pk === lowerKey)) {
        const val = obj[key];
        if (typeof val === "string") {
          const parsed = parseImageString(val, key, images.length);
          if (parsed) {
            const dedupKey = parsed.rawBase64 || parsed.src;
            if (!visited.has(dedupKey)) {
              visited.add(dedupKey);
              images.push(parsed);
            }
          }
        } else if (Array.isArray(val)) {
          val.forEach((item, idx) => {
            if (typeof item === "string") {
              const parsed = parseImageString(item, `${key}[${idx}]`, images.length);
              if (parsed) {
                const dedupKey = parsed.rawBase64 ? parsed.rawBase64.slice(0, 40) : parsed.src;
                if (!visited.has(dedupKey)) {
                  visited.add(dedupKey);
                  images.push(parsed);
                }
              }
            }
          });
        }
      }
    }
  }

  // 2. Fallback scan if no priority keys found: scan all keys for image strings
  if (images.length === 0) {
    for (const { obj } of targets) {
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string") {
          const parsed = parseImageString(val, key, images.length);
          if (parsed) {
            const dedupKey = parsed.rawBase64 ? parsed.rawBase64.slice(0, 40) : parsed.src;
            if (!visited.has(dedupKey)) {
              visited.add(dedupKey);
              images.push(parsed);
            }
          }
        } else if (Array.isArray(val)) {
          val.forEach((item, idx) => {
            if (typeof item === "string") {
              const parsed = parseImageString(item, `${key}[${idx}]`, images.length);
              if (parsed) {
                const dedupKey = parsed.rawBase64 ? parsed.rawBase64.slice(0, 40) : parsed.src;
                if (!visited.has(dedupKey)) {
                  visited.add(dedupKey);
                  images.push(parsed);
                }
              }
            }
          });
        }
      }
    }
  }

  return images;
}

/**
 * Sanitize output object, replacing large Base64 / data:image strings with
 * `[${sizeKB}KB ${mimeType} base64 string]`.
 */
export function sanitizeWebAutoOutput(output: unknown): unknown {
  if (output === null || output === undefined) return null;
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (parsed && typeof parsed === "object") {
        return sanitizeWebAutoOutput(parsed);
      }
      return output;
    } catch {
      return output;
    }
  }

  try {
    return JSON.parse(
      JSON.stringify(output, (_key, value) => {
        if (typeof value === "string") {
          if (isDataImageUri(value)) {
            const match = value.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/i);
            if (match && match[1] && match[2]) {
              const mimeType = match[1];
              const sizeKB = Math.max(1, Math.round((match[2].length * 0.75) / 1024));
              return `[${sizeKB}KB ${mimeType} base64 string]`;
            }
          } else if (
            value.length > 200 &&
            !value.includes(" ") &&
            /^[A-Za-z0-9+/=]+$/.test(value)
          ) {
            const sizeKB = Math.max(1, Math.round((value.length * 0.75) / 1024));
            return `[${sizeKB}KB image/png base64 string]`;
          }
        }
        return value;
      }),
    );
  } catch {
    return output;
  }
}

/**
 * Format execution output for display, replacing large Base64 / data:image
 * strings with concise placeholder summaries: `[${sizeKB}KB ${mimeType} base64 string]`.
 */
export function formatWebAutoOutputForDisplay(output: unknown): string {
  if (output === null || output === undefined) return "";
  const sanitized = sanitizeWebAutoOutput(output);
  if (typeof sanitized === "string") return sanitized;
  try {
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return String(output);
  }
}
