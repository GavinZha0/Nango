/**
 * Agent pipeline — G9 Tool Result Sanitization Middleware.
 *
 * Neutralizes framework control tags (<system-reminder>, <assistant>, etc.)
 * in results originating from external tools (web_search, external MCPs)
 * to prevent indirect prompt injection.
 *
 * See docs/architecture-improvements.md "P1 — Safety Guardrails".
 */

import "server-only";

import { BUILTIN_TOOL_RISK_MAP } from "./risk-registry";
import { wrapUntrustedContext } from "./untrusted-context";
import { defineToolMiddleware } from "./compose";
import type { ToolMiddleware } from "./types";

/**
 * Decode encoded angle brackets to prevent encoding-based bypass of system tags.
 * Only targets < and > to avoid corrupting legitimate text/unicode sequences.
 * Handles: &#60;, &#x3C;, \u003C, \x3C, &lt;, and their uppercase/> equivalents.
 */
function decodeHtmlEntities(text: string): string {
  let decoded = text;

  // Replace various encoded forms of '<'
  decoded = decoded.replace(/(?:&#60;|&#x3[cC];|&lt;|\\u003[cC]|\\x3[cC])/g, "<");
  
  // Replace various encoded forms of '>'
  decoded = decoded.replace(/(?:&#62;|&#x3[eE];|&gt;|\\u003[eE]|\\x3[eE])/g, ">");

  return decoded;
}

/** Known system framework tags commonly used in prompt injection. */
const DANGEROUS_FRAMEWORK_TAGS = [
  /<system-reminder>/gi,
  /<\/system-reminder>/gi,
  /<system>/gi,
  /<\/system>/gi,
  /<assistant>/gi,
  /<\/assistant>/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<tool_call>/gi,
  /<\/tool_call>/gi,
  /<tool_response>/gi,
  /<\/tool_response>/gi,
];

/**
 * Sanitize framework tags in raw text.
 * First decodes HTML entities and Unicode escapes to prevent encoding-based bypass,
 * then neutralizes dangerous framework tags.
 */
export function sanitizeToolResultText(text: string): string {
  if (!text) return text;

  // SECURITY: Decode encoded tags first to prevent bypass attacks
  const decoded = decodeHtmlEntities(text);

  let cleaned = decoded;
  for (const tagPattern of DANGEROUS_FRAMEWORK_TAGS) {
    cleaned = cleaned.replace(tagPattern, (match) => {
      return match.replace("<", "&lt;").replace(">", "&gt;");
    });
  }
  return cleaned;
}

import { getConfigBoolean } from "@/lib/config";
import { setTempMedia } from "@/lib/media/temp-media-cache";

function processImageContent(
  content: Array<Record<string, unknown>>,
  toolCallId?: string,
): Array<Record<string, unknown>> {
  const cropEnabled = getConfigBoolean("mcp.crop_image_for_llm", true);

  return content.map((item, idx) => {
    if (item && item.type === "image" && typeof item.data === "string") {
      const mediaId = toolCallId ? `${toolCallId}_${idx}` : `img_${Date.now()}_${idx}`;
      const mimeType = typeof item.mimeType === "string" ? item.mimeType : "image/png";

      // Cache full image buffer in server-side memory cache
      setTempMedia(mediaId, item.data, mimeType);
      const url = `/api/media/tool-image/${mediaId}`;
      const sizeKB = Math.round((item.data.length * 0.75) / 1024);

      if (cropEnabled) {
        return {
          ...item,
          url,
          data: `[${sizeKB}KB ${mimeType} base64 string]`,
        };
      } else {
        return {
          ...item,
          url,
        };
      }
    }
    return item;
  });
}

/**
 * Determine if a tool is external (Web search, external MCP server)
 * vs a local trusted system tool (SQL, local bash, file read).
 */
export function isExternalTool(toolName: string): boolean {
  if (toolName === "web_search" || toolName === "web_fetch") return true;
  // If it's not a known built-in tool, treat as external MCP tool
  if (!BUILTIN_TOOL_RISK_MAP.has(toolName)) return true;
  return false;
}

/**
 * Order 55 — Outbound middleware that sanitizes and wraps external tool results.
 */
export function toolResultSanitizationMiddleware(): ToolMiddleware {
  return defineToolMiddleware({
    name: "tool-result-sanitization",
    order: 55,
    wrapToolCall: async (_ctx, call, next) => {
      const rawResult = await next(call);

      // Process image content in tool results (both external and internal)
      if (rawResult && typeof rawResult === "object") {
        if (Array.isArray(rawResult)) {
          return processImageContent(rawResult as Array<Record<string, unknown>>, call.toolCallId);
        }

        const resObj = rawResult as Record<string, unknown>;
        if (Array.isArray(resObj.content)) {
          const processedContent = processImageContent(
            resObj.content as Array<Record<string, unknown>>,
            call.toolCallId,
          );

          if (isExternalTool(call.toolName)) {
            const sanitizedContent = processedContent.map((entry) => {
              if (entry.type === "text" && typeof entry.text === "string") {
                return { ...entry, text: wrapUntrustedContext(sanitizeToolResultText(entry.text)) };
              }
              return entry;
            });
            return { ...resObj, content: sanitizedContent };
          }
          return { ...resObj, content: processedContent };
        }
      }

      // Only sanitize external tools
      if (!isExternalTool(call.toolName)) {
        return rawResult;
      }

      // If string result
      if (typeof rawResult === "string") {
        const sanitized = sanitizeToolResultText(rawResult);
        return wrapUntrustedContext(sanitized);
      }

      // If object result containing text/content fields
      if (rawResult && typeof rawResult === "object") {
        const resObj = rawResult as Record<string, unknown>;
        // Return new object to avoid mutating the original reference
        if (typeof resObj.text === "string") {
          return { ...resObj, text: wrapUntrustedContext(sanitizeToolResultText(resObj.text)) };
        } else if (typeof resObj.content === "string") {
          return { ...resObj, content: wrapUntrustedContext(sanitizeToolResultText(resObj.content)) };
        } else if (typeof resObj.output === "string") {
          return { ...resObj, output: wrapUntrustedContext(sanitizeToolResultText(resObj.output)) };
        }
        return rawResult;
      }

      return rawResult;
    },
  });
}
