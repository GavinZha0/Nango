/**
 * Server-side `generate_echarts_config` agent tool.
 *
 * The server-side handler is a PURE VALIDATOR — it does NOT write
 * to any store and does NOT call any external service. The chart
 * appearing in the user's Outcomes panel is driven entirely on the
 * client side by a side-effect hook in `ChartPreviewCard` that
 * listens for this tool's `tool_call_result` event.
 *
 * See docs/workflow-spec.md (chart node + two LLM authoring
 * contexts) and docs/data-visualization.md.
 */

import "server-only";

import { defineTool, type ToolDefinition } from "@/lib/copilot/index.server";

import {
  ECHARTS_OPTION_HARD_CAP_BYTES,
  generateEchartsConfigSchema,
  type GenerateEchartsConfigArgs,
  type GenerateEchartsConfigResult,
  HTML_PAGE_HARD_CAP_BYTES,
  generateHtmlPageSchema,
  type GenerateHtmlPageArgs,
  type GenerateHtmlPageResult,
  BENTO_DOC_HARD_CAP_BYTES,
  generateBentoSlidesSchema,
  type GenerateBentoSlidesArgs,
  type GenerateBentoSlidesResult,
  editBentoSlidesSchema,
  type EditBentoSlidesArgs,
  type EditBentoSlidesResult,
  normalizeOutcomeId,
} from "./schema";

/**
 * Build the `generate_echarts_config` tool definition.
 *
 * Mounted as an ambient tool on every non-supervisor built-in agent
 * via `lib/runner/dispatch/builtin.ts` — every agent that can speak
 * to the user can therefore push a chart to the Outcomes panel.
 *
 * Validation contract:
 *   - `option` serialized JSON ≤ ECHARTS_OPTION_HARD_CAP_BYTES
 *   - `option.series` is a non-empty array
 * On failure returns `{ ok: false, error, message }` so the LLM can
 * self-correct on the next turn; on success returns the entire
 * payload (chart_id / title / description / option / dataset_id)
 * verbatim so the frontend side-effect hook can update the Outcomes
 * store without re-deriving anything from the original args.
 */
export function buildGenerateEchartsConfigTool(): ToolDefinition {
  return defineTool({
    name: "generate_echarts_config",
    description:
      "Generate an ECharts visualization config and surface it as a " +
      "preview card in the user's Outcomes panel. The chart renders " +
      "in chat IMMEDIATELY on success — DO NOT also paste chart JSON " +
      "into your text reply. Re-calling with the same chart_id " +
      "OVERWRITES the previous chart. " +
      "USE THIS when the user asks for a chart / plot / graph / " +
      "visualization AND you have concrete data values to chart. " +
      "If you have no data, reply in text instead — do not invent " +
      "or hardcode sample data. " +
      "FORMAT: put data in `option.dataset.source` (array of row " +
      "objects), and bind columns via `series[*].encode = { x, y }`. " +
      "DO NOT put values in `series[*].data`. " +
      "When the chart is rendered from data you just fetched via " +
      "`extract_dataset_by_sql`, pass that dataset's id as " +
      "`dataset_id` — this lets the save pipeline rebuild a " +
      "refreshable data binding.",
    parameters: generateEchartsConfigSchema,
    execute: async (
      args: GenerateEchartsConfigArgs,
    ): Promise<GenerateEchartsConfigResult> => {
      const normalized = normalizeOutcomeId(args.outcome_id);
      const isModified = normalized !== args.outcome_id;
      const finalId = normalized;

      // size cap — measured on the serialized option
      const serialized = JSON.stringify(args.option);
      if (serialized.length > ECHARTS_OPTION_HARD_CAP_BYTES) {
        return {
          ok: false,
          error: "OPTION_TOO_LARGE",
          message:
            `option is ${serialized.length} bytes when serialized; ` +
            `cap is ${ECHARTS_OPTION_HARD_CAP_BYTES}. Aggregate via ` +
            `run_code_in_sandbox or run a SQL extraction first, then ` +
            `chart the result.`,
        };
      }

      // structure check — series must be a non-empty array
      const series = (args.option as { series?: unknown }).series;
      if (!Array.isArray(series) || series.length === 0) {
        return {
          ok: false,
          error: "OPTION_NO_SERIES",
          message:
            "option.series must be a non-empty array; each entry " +
            "must include a `type` (e.g. 'bar', 'line', 'pie').",
        };
      }

      // interceptor 1: prevent data in series
      const hasDataInSeries = series.some((s: { data?: unknown }) => s && Array.isArray(s.data) && s.data.length > 0);
      if (hasDataInSeries) {
        return {
          ok: false,
          error: "DATA_IN_SERIES",
          message: "CRITICAL: You put data inside `series[*].data`. You MUST remove it and map data exclusively via `series[*].encode` using `dataset.source`.",
        };
      }

      // interceptor 2: enforce dataset.source is an array of row objects
      const dataset = (args.option as { dataset?: { source?: unknown } }).dataset;
      const source = dataset?.source;
      if (Array.isArray(source) && source.length > 0 && Array.isArray(source[0])) {
        return {
          ok: false,
          error: "DATASET_FORMAT_INVALID",
          message: "CRITICAL: `dataset.source` is a 2D array (array of arrays). It MUST be an array of row objects (e.g. [{ name: 'apple', value: 10 }]) EXACTLY matching the upstream tool's output.",
        };
      }

      return {
        ok: true,
        outcome_id: finalId,
        title: args.title,
        ...(args.description !== undefined && {
          description: args.description,
        }),
        option: args.option,
        ...(args.dataset_id !== undefined && { dataset_id: args.dataset_id }),
        ...(isModified && {
          message:
            `Note: The outcome_id was normalized to '${finalId}' (converted to ` +
            `lowercase, replaced spaces with hyphens, and stripped disallowed chars) ` +
            `to ensure it complies with storage regulations. Use '${finalId}' to update this chart in future turns.`,
        }),
      };
    },
  });
}

/**
 * Build the `generate_html_page` tool definition.
 *
 * Mounted as an opt-in built-in tool via the admin's "Built-in
 * Tools" checkbox. The tool validates the HTML payload size and
 * echoes it back verbatim so the frontend side-effect hook can
 * update the Outcomes store.
 *
 * Validation contract:
 *   - `html` serialized length ≤ HTML_PAGE_HARD_CAP_BYTES
 *   - `html` must be a non-empty string
 * On failure returns `{ ok: false, error, message }` so the LLM
 * can self-correct on the next turn.
 */
export function buildGenerateHtmlPageTool(): ToolDefinition {
  return defineTool({
    name: "generate_html_page",
    description:
      "Generate a complete HTML page and surface it as a preview " +
      "card in the user's Outcomes panel. The page renders in a " +
      "sandboxed iframe IMMEDIATELY on success — DO NOT paste the " +
      "HTML source into your text reply. Re-calling with the same " +
      "page_id OVERWRITES the previous page. " +
      "USE THIS when the user asks for a web page, landing page, " +
      "interactive visualization, prototype, or any rich HTML " +
      "content. " +
      "FORMAT: provide a complete HTML document string. Inline " +
      "small CSS/JS via <style>/<script> tags. For large " +
      "libraries (D3, Three.js, Tailwind, etc.) use public CDN " +
      "links (cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com). " +
      "The iframe sandbox blocks form submissions and top-level " +
      "navigation but allows scripts.",
    parameters: generateHtmlPageSchema,
    execute: async (
      args: GenerateHtmlPageArgs,
    ): Promise<GenerateHtmlPageResult> => {
      // size cap
      const byteLength = new TextEncoder().encode(args.html).length;
      if (byteLength > HTML_PAGE_HARD_CAP_BYTES) {
        return {
          ok: false,
          error: "HTML_TOO_LARGE",
          message:
            `HTML is ${byteLength} bytes; cap is ${HTML_PAGE_HARD_CAP_BYTES}. ` +
            `Move large libraries to CDN links and reduce inline content.`,
        };
      }

      // empty check (schema min(1) should catch, but belt-and-suspenders)
      if (args.html.trim().length === 0) {
        return {
          ok: false,
          error: "HTML_EMPTY",
          message: "html must contain non-whitespace content.",
        };
      }

      const originalPageId = args.outcome_id;
      const finalPageId = normalizeOutcomeId(originalPageId);

      return {
        ok: true,
        outcome_id: finalPageId,
        title: args.title,
        ...(args.description !== undefined && {
          description: args.description,
        }),
        html: args.html,
        ...(originalPageId !== finalPageId && {
          message: `The outcome_id was normalized from "${originalPageId}" to "${finalPageId}". Please use "${finalPageId}" for subsequent updates.`,
        }),
      };
    },
  });
}

/**
 * Build the `generate_bento_slides` tool definition.
 *
 * Mounted as an opt-in built-in tool via the agent editor's "Built-in
 * Tools" section. The tool validates the Bento slides JSON doc payload
 * size and schema format, echoing it back verbatim so the frontend
 * side-effect hook can update the Outcomes store.
 *
 * Validation contract:
 *   - `doc` serialized length <= BENTO_DOC_HARD_CAP_BYTES (512KB)
 *   - `doc.format === "bento/slides"`
 *   - `doc.slides` is a non-empty array
 * On failure returns `{ ok: false, error, message }` so the LLM
 * can self-correct on the next turn.
 */
export function buildGenerateBentoSlidesTool(): ToolDefinition {
  return defineTool({
    name: "generate_bento_slides",
    description:
      "Generate an interactive slide deck presentation using Bento and " +
      "surface it as a preview card in the user's Outcomes panel. The deck " +
      "renders in a sandboxed iframe with morph transitions IMMEDIATELY on " +
      "success — DO NOT paste the JSON doc into your text reply. " +
      "Re-calling with the same outcome_id OVERWRITES the previous slide deck. " +
      "For incremental updates or adding new slides, use edit_bento_slides. " +
      "USE THIS when the user asks for a presentation, pitch deck, slide deck, " +
      "or visual report slides. " +
      "FORMAT: doc must have format: 'bento/slides' and a non-empty slides array. " +
      "Each slide is 1280x720 and must have a unique, explicit 'id'. For morph transitions across slides, use the same id. " +
      "Charts in Bento use charts-lite — provide simple numbers in series[*].data.",
    parameters: generateBentoSlidesSchema,
    execute: async (
      args: GenerateBentoSlidesArgs,
    ): Promise<GenerateBentoSlidesResult> => {
      // size cap on serialized doc
      const serialized = JSON.stringify(args.doc);
      const byteLength = new TextEncoder().encode(serialized).length;
      if (byteLength > BENTO_DOC_HARD_CAP_BYTES) {
        return {
          ok: false,
          error: "DOC_TOO_LARGE",
          message:
            `Bento doc is ${byteLength} bytes; cap is ${BENTO_DOC_HARD_CAP_BYTES}. ` +
            `Reduce slide count, shorten prose, or simplify embedded data.`,
        };
      }

      // slides check
      if (!Array.isArray(args.doc.slides) || args.doc.slides.length === 0) {
        return {
          ok: false,
          error: "DOC_NO_SLIDES",
          message: "doc.slides must be a non-empty array of slide objects.",
        };
      }

      // CONTRACT: Validate slide ID presence and uniqueness (P0-1 / P0-2)
      const seenSlideIds = new Set<string>();
      for (let i = 0; i < args.doc.slides.length; i++) {
        const slide = args.doc.slides[i];
        if (
          !slide ||
          typeof slide !== "object" ||
          typeof (slide as Record<string, unknown>).id !== "string" ||
          !(slide as Record<string, unknown>).id
        ) {
          return {
            ok: false,
            error: "SLIDE_MISSING_ID",
            message: `Slide at index ${i} is missing a non-empty string "id". Every slide must have an explicit immutable id.`,
          };
        }
        const slideId = String((slide as Record<string, unknown>).id);
        if (seenSlideIds.has(slideId)) {
          return {
            ok: false,
            error: "DUPLICATE_SLIDE_ID",
            message: `Duplicate slide id "${slideId}" found in doc.slides at index ${i}. Slide IDs must be unique within the deck.`,
          };
        }
        seenSlideIds.add(slideId);
      }

      // CONTRACT: Auto-polyfill defensive metadata (format, version, title, size).
      // LLMs calling generate_bento_slides may occasionally omit or shorthand doc.format
      // (e.g. 'slides'). Rather than failing and triggering a costly re-generation turn,
      // normalize it to 'bento/slides'.
      if (args.doc.format !== "bento/slides") {
        args.doc.format = "bento/slides";
      }
      if (!args.doc.version) {
        args.doc.version = 1;
      }
      if (!args.doc.title && args.title) {
        args.doc.title = args.title;
      }
      if (!args.doc.size) {
        args.doc.size = { width: 1280, height: 720 };
      }

      const originalOutcomeId = args.outcome_id;
      const finalOutcomeId = normalizeOutcomeId(originalOutcomeId);

      return {
        ok: true,
        outcome_id: finalOutcomeId,
        title: args.title,
        ...(args.description !== undefined && {
          description: args.description,
        }),
        doc: args.doc,
        ...(originalOutcomeId !== finalOutcomeId && {
          message: `The outcome_id was normalized from "${originalOutcomeId}" to "${finalOutcomeId}". Please use "${finalOutcomeId}" for subsequent updates.`,
        }),
      };
    },
  });
}

/**
 * Build the `edit_bento_slides` tool definition.
 *
 * PURE VALIDATOR — stateless. Does NOT read or write database rows.
 * Validates semantic constraints on the edit delta and returns the operation
 * payload verbatim so the shared reducer `applySlideEdit` can apply it
 * deterministically across the frontend store and backend replay.
 */
export function buildEditBentoSlidesTool(): ToolDefinition {
  return defineTool({
    name: "edit_bento_slides",
    description:
      "Edit an existing Bento slides deck incrementally (delete, replace, or insert/append slides). " +
      "Use this tool when updating, fixing, or incrementally adding slides instead of re-generating the entire deck. " +
      "Supported actions: " +
      "1) 'delete': removes slides specified in target_slide_ids. " +
      "2) 'replace': substitutes targeted slides with new slides (1-to-1 match; preserves target slide ID). " +
      "3) 'insert': adds new slides (omitting target_slide_ids appends to end; ['0'] inserts at start; ['<id>'] inserts after).",
    parameters: editBentoSlidesSchema,
    execute: async (
      args: EditBentoSlidesArgs,
    ): Promise<EditBentoSlidesResult> => {
      // 1. Size cap validation on serialized payload (if slides are provided)
      if (args.slides && args.slides.length > 0) {
        const serialized = JSON.stringify(args.slides);
        const byteLength = new TextEncoder().encode(serialized).length;
        if (byteLength > BENTO_DOC_HARD_CAP_BYTES) {
          return {
            ok: false,
            error: "SLIDES_TOO_LARGE",
            message:
              `Slides payload is ${byteLength} bytes; cap is ${BENTO_DOC_HARD_CAP_BYTES}. ` +
              `Reduce slide count or simplify embedded data.`,
          };
        }
      }

      // 2. Semantic validations by action
      const { action, target_slide_ids, slides } = args;

      if (action === "delete") {
        if (slides && slides.length > 0) {
          return {
            ok: false,
            error: "UNEXPECTED_SLIDES",
            message: "Action 'delete' does not accept 'slides'. Only provide 'target_slide_ids'.",
          };
        }
        if (!target_slide_ids || target_slide_ids.length === 0) {
          return {
            ok: false,
            error: "TARGET_SLIDE_IDS_REQUIRED",
            message: "Action 'delete' requires 'target_slide_ids'.",
          };
        }
      } else if (action === "replace") {
        if (!target_slide_ids || target_slide_ids.length === 0) {
          return {
            ok: false,
            error: "TARGET_SLIDE_IDS_REQUIRED",
            message: "Action 'replace' requires 'target_slide_ids'.",
          };
        }
        if (!slides || slides.length === 0) {
          return {
            ok: false,
            error: "SLIDES_REQUIRED",
            message: "Action 'replace' requires a non-empty 'slides' array.",
          };
        }
        if (slides.length !== target_slide_ids.length) {
          return {
            ok: false,
            error: "REPLACE_COUNT_MISMATCH",
            message:
              `Action 'replace' requires exactly matching counts: ` +
              `received ${slides.length} slide(s) for ${target_slide_ids.length} target id(s).`,
          };
        }
        const targetSet = new Set(target_slide_ids);
        if (targetSet.size !== target_slide_ids.length) {
          return {
            ok: false,
            error: "DUPLICATE_TARGET_SLIDE_ID",
            message: "Action 'replace' received duplicate IDs in 'target_slide_ids'.",
          };
        }
      } else if (action === "insert") {
        if (!slides || slides.length === 0) {
          return {
            ok: false,
            error: "SLIDES_REQUIRED",
            message: "Action 'insert' requires at least one slide in 'slides'.",
          };
        }
        const seenInsertIds = new Set<string>();
        for (let i = 0; i < slides.length; i++) {
          const s = slides[i];
          if (
            !s ||
            typeof s !== "object" ||
            typeof s.id !== "string" ||
            !s.id
          ) {
            return {
              ok: false,
              error: "SLIDE_MISSING_ID",
              message: `Slide at index ${i} in 'slides' is missing a non-empty string "id". Every inserted slide must have an explicit immutable id.`,
            };
          }
          if (seenInsertIds.has(s.id)) {
            return {
              ok: false,
              error: "DUPLICATE_SLIDE_ID",
              message: `Duplicate slide id "${s.id}" found in 'slides' at index ${i}.`,
            };
          }
          seenInsertIds.add(s.id);
        }
      }

      // 3. Slide sanity check and ID immutability enforcement
      let normalizedSlides: Array<Record<string, unknown>> | undefined;
      if (slides && slides.length > 0) {
        normalizedSlides = slides.map((s, idx) => {
          const slideObj = { ...s };
          if (!Array.isArray(slideObj.elements)) {
            slideObj.elements = [];
          }
          // CONTRACT: Replace preserves the target slide ID to guarantee immutability
          if (action === "replace" && target_slide_ids && target_slide_ids[idx]) {
            slideObj.id = target_slide_ids[idx];
          }
          return slideObj;
        });
      }

      const originalOutcomeId = args.outcome_id;
      const finalOutcomeId = normalizeOutcomeId(originalOutcomeId);

      return {
        ok: true,
        outcome_id: finalOutcomeId,
        action: args.action,
        ...(args.target_slide_ids !== undefined && {
          target_slide_ids: args.target_slide_ids,
        }),
        ...(normalizedSlides !== undefined && { slides: normalizedSlides }),
        ...(originalOutcomeId !== finalOutcomeId && {
          message: `The outcome_id was normalized from "${originalOutcomeId}" to "${finalOutcomeId}". Please use "${finalOutcomeId}" for subsequent updates.`,
        }),
      };
    },
  });
}

