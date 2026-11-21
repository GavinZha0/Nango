/**
 * Isomorphic helpers for folding `generative-ui-surface` activity
 * snapshots/deltas and validating `GenerativeUISurfaceContent` documents.
 *
 * Kept free of React imports so both server-side replay rebuilders and
 * client-side live subscribers share the exact same folding semantics.
 */

import { GenerativeUISurfaceContentSchema } from "@copilotkit/core/generative-ui";
import {
  createGenerativeUI,
  STANDARD_CATALOG_ID,
  standardDeclarations,
  type GenerativeUISurfaceContent,
} from "@copilotkit/shared/generative-ui";

const HEADLESS_COMPONENTS = Object.fromEntries(
  Object.entries(standardDeclarations).map(([name, decl]) => [
    name,
    { ...decl, component: null },
  ]),
) as unknown as Parameters<typeof createGenerativeUI>[0]["components"];

/**
 * Build a framework-agnostic GenerativeUI catalog matching `catalogId`
 * (e.g. `"nango/workspace@1"` or `"copilotkit/standard@1"`) without pulling
 * `@copilotkit/react-core/v2/generative-ui` React component bundles.
 */
export function createHeadlessCatalog(catalogId: string) {
  return createGenerativeUI({
    id: catalogId || STANDARD_CATALOG_ID,
    components: HEADLESS_COMPONENTS,
  });
}

export interface SurfacePatchOp {
  op: string;
  path: string;
  value?: unknown;
}

/**
 * Apply CopilotKit `generative-ui-surface` JSON-Patch deltas immutably.
 * Supports the four paths emitted by the runtime:
 *   - `/operations/-` (append operation) and `/operations/<idx>`
 *   - `/status`
 *   - `/rejected`
 *   - `/rejected/-` (append rejection)
 */
export function applySurfaceDelta(
  current: Record<string, unknown>,
  patch: ReadonlyArray<SurfacePatchOp>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  let opsCloned = false;
  let rejectedCloned = false;

  const ensureOps = (): unknown[] => {
    if (!opsCloned) {
      next.operations = Array.isArray(next.operations) ? [...next.operations] : [];
      opsCloned = true;
    }
    return next.operations as unknown[];
  };

  const ensureRejected = (): unknown[] => {
    if (!rejectedCloned) {
      next.rejected = Array.isArray(next.rejected) ? [...next.rejected] : [];
      rejectedCloned = true;
    }
    return next.rejected as unknown[];
  };

  for (const step of patch) {
    if (!step || typeof step.path !== "string") continue;

    if (step.path === "/operations/-") {
      if (step.op === "add" || step.op === "replace") {
        ensureOps().push(step.value);
      }
      continue;
    }

    if (step.path.startsWith("/operations/")) {
      const idxStr = step.path.slice("/operations/".length);
      const idx = Number(idxStr);
      if (Number.isInteger(idx) && idx >= 0 && (step.op === "replace" || step.op === "add")) {
        const ops = ensureOps();
        ops[idx] = step.value;
      }
      continue;
    }

    if (step.path === "/status") {
      if (step.op === "replace" || step.op === "add") {
        next.status = step.value;
      }
      continue;
    }

    if (step.path === "/rejected") {
      if (step.op === "replace" || step.op === "add") {
        next.rejected = Array.isArray(step.value) ? [...step.value] : [];
        rejectedCloned = true;
      }
      continue;
    }

    if (step.path === "/rejected/-") {
      if (step.op === "add" || step.op === "replace") {
        ensureRejected().push(step.value);
      }
      continue;
    }
  }

  return next;
}

/** Validate and return a `GenerativeUISurfaceContent` document, or `null` if invalid. */
export function parseSurfaceContent(raw: unknown): GenerativeUISurfaceContent | null {
  const res = GenerativeUISurfaceContentSchema.safeParse(raw);
  return res.success ? (res.data as GenerativeUISurfaceContent) : null;
}

/** Deterministic outcomeId for an A2UI surface within a thread. */
export function deriveSurfaceOutcomeId(surfaceId: string): string {
  return `genui:${surfaceId}`;
}

/**
 * Best-effort human-readable title for an A2UI surface: inspects `createSurface`
 * and `updateComponents` operations for the first literal `Title` component's
 * `text` (falling back to the first literal `Text` component, then `surfaceId`).
 */
export function extractSurfaceTitle(surface: GenerativeUISurfaceContent): string {
  let firstText: string | null = null;
  for (const op of surface.operations) {
    if (!op || typeof op !== "object") continue;
    const rec = op as unknown as Record<string, unknown>;
    const sources = [
      (rec.createSurface as { components?: unknown[] } | undefined)?.components,
      (rec.updateComponents as { components?: unknown[] } | undefined)?.components,
    ];
    for (const components of sources) {
      if (!Array.isArray(components)) continue;
      for (const comp of components) {
        if (!comp || typeof comp !== "object") continue;
        const c = comp as Record<string, unknown>;
        if (c.component === "Title" && typeof c.text === "string" && c.text.trim().length > 0) {
          return c.text.trim();
        }
        if (
          firstText === null &&
          c.component === "Text" &&
          typeof c.text === "string" &&
          c.text.trim().length > 0
        ) {
          const trimmed = c.text.trim();
          firstText = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
        }
      }
    }
  }
  return firstText ?? surface.surfaceId;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function normalizeRenderUiOperation(op: unknown): { op: unknown; changed: boolean } {
  if (!isPlainObject(op)) return { op, changed: false };
  const next: Record<string, unknown> = { ...op };
  let changed = false;

  if (isPlainObject(next.updateComponents)) {
    const uc = { ...next.updateComponents };
    if (
      (!Array.isArray(uc.components) || uc.components.length === 0) &&
      Array.isArray(next.components) &&
      next.components.length > 0
    ) {
      uc.components = next.components;
      delete next.components;
      changed = true;
    }
    if (!uc.surfaceId && typeof next.surfaceId === "string") {
      uc.surfaceId = next.surfaceId;
      changed = true;
    }
    if ("surfaceId" in next) {
      delete next.surfaceId;
      changed = true;
    }
    if (changed) next.updateComponents = uc;
  } else if (isPlainObject(next.createSurface)) {
    const cs = { ...next.createSurface };
    for (const key of ["surfaceId", "catalogId", "dataModel", "components"] as const) {
      if (key in next) {
        if (
          cs[key] === undefined ||
          (key === "components" && Array.isArray(cs.components) && cs.components.length === 0)
        ) {
          cs[key] = next[key];
        }
        delete next[key];
        changed = true;
      }
    }
    if (changed) next.createSurface = cs;
  } else if (isPlainObject(next.updateDataModel)) {
    const ud = { ...next.updateDataModel };
    for (const key of ["surfaceId", "path", "value"] as const) {
      if (key in next) {
        if (ud[key] === undefined) ud[key] = next[key];
        delete next[key];
        changed = true;
      }
    }
    if (changed) next.updateDataModel = ud;
  }

  return { op: changed ? next : op, changed };
}

/**
 * Repair common LLM argument nesting mistakes on `render_ui` (e.g. placing
 * `components` / `surfaceId` at the outer operation object alongside an empty
 * `updateComponents: { components: [] }`) before CopilotKit's
 * `GenerativeUIMiddleware` validates them. Returns `rawJson` untouched if
 * nothing needed repair or if `rawJson` is not valid JSON.
 */
export function normalizeRenderUiArgsJson(rawJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return rawJson;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.operations)) {
    return rawJson;
  }

  let anyChanged = false;
  const operations = parsed.operations.map((item) => {
    const res = normalizeRenderUiOperation(item);
    if (res.changed) anyChanged = true;
    return res.op;
  });

  if (!anyChanged) return rawJson;
  return JSON.stringify({ ...parsed, operations });
}
