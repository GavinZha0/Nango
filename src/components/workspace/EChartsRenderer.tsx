"use client";

/**
 * EChartsRenderer — single-chart renderer for the Outcomes panel.
 *
 * Hand-rolled wrapper around the `echarts` core package: `echarts.init`
 * on mount, `setOption(option, true)` on every option change, dispose
 * on unmount. Bundle cost is paid only when the user navigates to
 * `/outcomes`, which lazy-loads `OutcomesPanel` via `next/dynamic`.
 *
 * Constraints (see `docs/data-visualization.md`):
 *  - Theme: read `next-themes` resolvedTheme; switch ECharts'
 *    built-in `dark` theme. ECharts has no live-swap-theme API, so
 *    a theme change disposes the instance and creates a fresh one;
 *    the `setOption` effect re-runs (it watches `resolvedTheme`)
 *    and re-pushes the option into the new instance.
 *  - Error isolation: setOption errors throw up to the surrounding
 *    `<ChartErrorBoundary>` so one bad chart doesn't kill the
 *    whole panel.
 *  - Resize: ResizeObserver keeps the chart filled when the
 *    container changes size.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import * as echarts from "echarts";
import { useTheme } from "next-themes";

interface EChartsRendererProps {
  /** Full ECharts option JSON. */
  option: Record<string, unknown>;
  style?: CSSProperties;
}

/**
 * EChartsRenderer — imperative wrapper over the `echarts` core
 * package.
 *
 * Behaviour:
 *  - `echarts.init` on mount; re-init when `resolvedTheme` flips
 *    (ECharts has no live-swap-theme API).
 *  - `setOption(option, true)` whenever `option` OR `resolvedTheme`
 *    changes — the latter is critical: a theme flip disposes the
 *    old instance and creates an empty new one in the init effect,
 *    so this effect MUST also re-run to push the option into the
 *    fresh instance. Without `resolvedTheme` in the deps the chart
 *    goes blank until the next option change.
 *  - ResizeObserver auto-resize so the chart fills its (definite-
 *    height) container, including when /outcomes navigates back in.
 *  - Dispose on unmount.
 *
 * See docs/data-visualization.md.
 */

/** Marks a value the sanitizer removed so its key falls back to the
 *  ECharts default (used for unexecutable function strings). */
const REMOVE_UNSAFE = Symbol("remove-unsafe-value");

/** ECharts function-valued keys the LLM may hallucinate as strings. A
 *  bare `startsWith("(")+"=>"` / `function` / `ident =>` heuristic —
 *  identical to what the old eval path gated on. */
function looksLikeFunctionString(str: string): boolean {
  return (
    str.startsWith("function") ||
    (str.startsWith("(") && str.includes("=>")) ||
    /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>/.test(str)
  );
}

/** `valueFormatter` MUST be a function or ECharts crashes. Convert a
 *  hallucinated string into a SAFE function by substitution only —
 *  never by executing the string. */
function safeValueFormatter(str: string): (val: unknown) => string {
  if (str.includes("{c}")) {
    return (val: unknown) => str.replace(/{c}/g, String(val));
  }
  if (looksLikeFunctionString(str)) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        '[EChartsRenderer] valueFormatter function string is not executed; ' +
          'use a template like "{c}%" or pre-format upstream:',
        str,
      );
    }
    return (val: unknown) => String(val);
  }
  // Plain unit suffix, e.g. " 亿人".
  return (val: unknown) => String(val) + (str.startsWith(" ") ? "" : " ") + str;
}

/**
 * Sanitize an ECharts option before `setOption`.
 *
 * SECURITY: never execute LLM-authored strings. The previous version
 * used `new Function("return "+str)()` to "heal" formatter strings —
 * that is arbitrary JS in the app origin (BUG-8). Instead we keep
 * ECharts-native string templates as-is, convert `valueFormatter`
 * strings to a safe non-eval function, and drop any other
 * JS-function-looking string so ECharts falls back to its default.
 * Custom formatting logic belongs upstream (SQL/transform), not here.
 */
function sanitizeChartOption(obj: unknown, parentKey?: string): unknown {
  if (obj === null || typeof obj !== "object") {
    if (typeof obj === "string") {
      const str = obj.trim();
      if (parentKey === "valueFormatter") {
        return safeValueFormatter(str);
      }
      // `formatter` templates ("{b}: {c}") are valid ECharts strings and
      // pass through. A function-looking string (here or on renderItem,
      // symbolSize, etc.) is dropped — never executed.
      if (looksLikeFunctionString(str)) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            `[EChartsRenderer] dropped unexecuted function string at "${parentKey ?? "?"}":`,
            str,
          );
        }
        return REMOVE_UNSAFE;
      }
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj
      .map((item) => sanitizeChartOption(item, parentKey))
      .filter((item) => item !== REMOVE_UNSAFE);
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const sanitized = sanitizeChartOption(value, key);
    if (sanitized !== REMOVE_UNSAFE) {
      result[key] = sanitized;
    }
  }
  return result;
}

export function EChartsRenderer({ option, style }: EChartsRendererProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);
  const { resolvedTheme } = useTheme();

  // Init / re-init on theme change. ECharts has no "swap theme on
  // existing instance" API; we dispose and create a fresh one.
  useEffect(() => {
    if (!containerRef.current) return;
    const inst: echarts.ECharts = echarts.init(
      containerRef.current,
      resolvedTheme === "dark" ? "dark" : undefined,
    );
    instanceRef.current = inst;

    // Auto-resize on container size changes (theme change, route
    // re-entry, viewport resize).
    const ro = new ResizeObserver(() => {
      inst.resize();
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      inst.dispose();
      instanceRef.current = null;
    };
  }, [resolvedTheme]);

  // Push option on (option, theme) changes. `resolvedTheme` is in
  // the deps so a theme flip — which re-creates the instance above
  // — re-runs us with the new (empty) instance and re-applies the
  // current option. Without that, theme switch leaves the chart
  // blank until the next generate_echarts_config call.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // Print as JSON so verifiers can read / copy the exact payload
      // ECharts received. Default `console.log(object)` shows a live
      // collapsed view that hides empty nested objects.
      //
      // Uses `console.debug` (filtered out by default in the Chrome
      // devtools "Default levels" view) so multiple charts don't
      // flood the regular log stream — enable Verbose to see it.
      try {
        console.debug(
          "[EChartsRenderer] setOption JSON:\n" + JSON.stringify(option, null, 2),
        );
      } catch {
        console.debug("[EChartsRenderer] setOption (unstringifiable):", option);
      }
    }
    const inst = instanceRef.current;
    if (!inst) return;
    try {
      const parsedOption = sanitizeChartOption(option) as echarts.EChartsOption;
      inst.setOption(parsedOption, true /* notMerge */, true /* lazyUpdate */);
    } catch (err) {
      console.error("[EChartsRenderer] setOption failed:", err, "option:", option);
      throw err; // ChartErrorBoundary catches and renders fallback UI.
    }
  }, [option, resolvedTheme]);

  return (
    <div
      ref={containerRef}
      style={{ height: "100%", width: "100%", ...style }}
      data-component="echarts-renderer"
    />
  );
}
