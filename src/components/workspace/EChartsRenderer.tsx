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

/**
 * Recursively parse stringified functions in the ECharts option object.
 * LLMs often hallucinate formatter functions as strings (e.g., `valueFormatter: "(val) => val + '%'"`)
 * which crash ECharts tooltip rendering if passed directly as strings.
 */
function parseFunctions(obj: unknown, parentKey?: string): unknown {
  if (obj === null || typeof obj !== "object") {
    if (typeof obj === "string") {
      const str = obj.trim();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsedFn: ((...args: any[]) => any) | undefined;
      if (
        str.startsWith("function") ||
        (str.startsWith("(") && str.includes("=>")) ||
        /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>/.test(str)
      ) {
        try {
          parsedFn = new Function("return " + str)();
        } catch {
          // fallback below
        }
      }

      if (parsedFn) {
        // Auto-heal LLM hallucinations where it writes `formatter: (val) => val + '...'`
        // but ECharts passes a complex `params` object, resulting in `[object Object]...`
        if (parentKey === "formatter") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return function (params: any, ...args: any[]) {
            const res = parsedFn!(params, ...args);
            if (
              typeof res === "string" &&
              res.includes("[object Object]") &&
              params &&
              typeof params === "object" &&
              "value" in params
            ) {
              return parsedFn!(params.value, ...args);
            }
            return res;
          };
        }
        return parsedFn;
      }

      // ECharts fatal crash prevention: `valueFormatter` MUST be a function.
      // If the LLM hallucinated a string template (e.g. "{c} 亿人"), it will crash ECharts.
      // We convert it into a safe formatting function to preserve the unit.
      if (parentKey === "valueFormatter") {
        return (val: unknown) => {
          if (str.includes("{c}")) return str.replace(/{c}/g, String(val));
          return String(val) + (str.startsWith(" ") ? "" : " ") + str;
        };
      }
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => parseFunctions(item, parentKey));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = parseFunctions(value, key);
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
      const parsedOption = parseFunctions(option) as echarts.EChartsOption;
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
