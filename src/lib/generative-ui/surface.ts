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
