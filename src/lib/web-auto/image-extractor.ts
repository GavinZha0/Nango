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

/** Detect format from MIME type or data URI prefix */
function detectImageFormat(dataUriOrMime: string): "png" | "jpeg" | "webp" | "image" {
  const lower = dataUriOrMime.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpeg";
  if (lower.includes("webp")) return "webp";
  return "image";
}

/** Check if a string is a standard data:image URI */
function isDataImageUri(val: string): boolean {
  return /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(val);
}

/** Extract base64 payload and size */
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
          if (parsed && !visited.has(parsed.rawBase64)) {
            visited.add(parsed.rawBase64);
            images.push(parsed);
          }
        } else if (Array.isArray(val)) {
          val.forEach((item, idx) => {
            if (typeof item === "string") {
              const parsed = parseImageString(item, `${key}[${idx}]`, images.length);
              if (parsed && !visited.has(parsed.rawBase64.slice(0, 40))) {
                visited.add(parsed.rawBase64.slice(0, 40));
                images.push(parsed);
              }
            }
          });
        }
      }
    }
  }

  // 2. Fallback scan if no priority keys found: scan all keys for data:image
  if (images.length === 0) {
    for (const { obj } of targets) {
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string" && isDataImageUri(val)) {
          const parsed = parseImageString(val, key, images.length);
          if (parsed && !visited.has(parsed.rawBase64)) {
            visited.add(parsed.rawBase64);
            images.push(parsed);
          }
        } else if (Array.isArray(val)) {
          val.forEach((item, idx) => {
            if (typeof item === "string" && isDataImageUri(item)) {
              const parsed = parseImageString(item, `${key}[${idx}]`, images.length);
              if (parsed && !visited.has(parsed.rawBase64.slice(0, 40))) {
                visited.add(parsed.rawBase64.slice(0, 40));
                images.push(parsed);
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
 * Format execution output for display, replacing large Base64 / data:image
 * strings with concise placeholder summaries: `[${sizeKB}KB ${mimeType} base64 string]`.
 */
export function formatWebAutoOutputForDisplay(output: unknown): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (parsed && typeof parsed === "object") {
        return formatWebAutoOutputForDisplay(parsed);
      }
      return output;
    } catch {
      return output;
    }
  }

  try {
    const sanitized = JSON.parse(
      JSON.stringify(output, (_key, value) => {
        if (typeof value === "string") {
          if (isDataImageUri(value)) {
            const match = value.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/i);
            if (match && match[1] && match[2]) {
              const mimeType = match[1];
              const sizeKB = Math.round((match[2].length * 0.75) / 1024);
              return `[${sizeKB}KB ${mimeType} base64 string]`;
            }
          } else if (
            value.length > 200 &&
            !value.includes(" ") &&
            /^[A-Za-z0-9+/=]+$/.test(value)
          ) {
            const sizeKB = Math.round((value.length * 0.75) / 1024);
            return `[${sizeKB}KB image/png base64 string]`;
          }
        }
        return value;
      }),
    );
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return String(output);
  }
}
