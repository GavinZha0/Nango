"use client";

/**
 * A2uiBlock — standalone Generative UI (A2UI) renderer for `/outcomes`.
 *
 * Uses `@copilotkit/core/generative-ui`'s `GenerativeUISurfaceManager` and
 * `@copilotkit/shared/generative-ui`'s `standardDeclarations` directly so
 * surfaces render identically even when RightPanel is collapsed or switched
 * to an agent with `generativeUiEnabled = false`.
 *
 * SECURITY CONTRACT:
 * - Never uses `dangerouslySetInnerHTML`.
 * - `Link` only allows `http:` / `https:` URLs.
 * - `Image` only allows `http:`, `https:`, or `data:image/` URLs.
 * - `HtmlView` renders inside `<iframe sandbox="allow-scripts" srcDoc={...} />`
 *   without `allow-same-origin`.
 */

import { Fragment, useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  GenerativeUISurfaceManager,
  tryResolveDynamicValue,
} from "@copilotkit/core/generative-ui";
import { GENERATIVE_UI_ROOT_ID } from "@copilotkit/shared/generative-ui";

import { createHeadlessCatalog } from "@/lib/generative-ui/surface";
import type { A2uiBlock } from "@/store/outcome-store";
import { EChartsRenderer } from "../EChartsRenderer";
import type { BlockSize } from "./BlockList";

interface Props {
  block: A2uiBlock;
  size?: BlockSize;
}

type SurfaceModelLike = NonNullable<
  ReturnType<GenerativeUISurfaceManager["getSurface"]>
>["model"];

function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeImageSrc(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw.trim()) return false;
  if (raw.startsWith("data:image/")) return true;
  return isSafeHttpUrl(raw);
}

export function resolveA2uiProp(
  val: unknown,
  model: SurfaceModelLike,
): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string" && val.includes("${")) {
    return val.replace(/\$\{([^}]+)\}/g, (full, expr: string) => {
      const path = expr.trim();
      const resolved = model.dataModel.get(path.startsWith("/") ? path : `/${path}`);
      return resolved !== undefined && resolved !== null ? String(resolved) : full;
    });
  }
  if (typeof val === "object" && !Array.isArray(val)) {
    const res = tryResolveDynamicValue(val, {
      data: model.dataModel,
      basePath: undefined,
    });
    if (res.ok) return res.value;
    const rec = val as Record<string, unknown>;
    if (typeof rec["@path"] === "string") {
      return model.dataModel.get(rec["@path"]);
    }
  }
  return val;
}

const resolveProp = resolveA2uiProp;

function asString(val: unknown): string {
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return "";
}

const JUSTIFY_CLASS_MAP: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  spaceBetween: "justify-between w-full",
  between: "justify-between w-full",
  spaceAround: "justify-around w-full",
  around: "justify-around w-full",
  spaceEvenly: "justify-evenly w-full",
  evenly: "justify-evenly w-full",
  stretch: "justify-stretch w-full",
};

const ALIGN_CLASS_MAP: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  baseline: "items-baseline",
  stretch: "items-stretch",
};

const BADGE_SOFT_COLORS: Record<string, string> = {
  success: "border-emerald-500/30 bg-emerald-500/15 text-emerald-400",
  warning: "border-amber-500/30 bg-amber-500/15 text-amber-400",
  danger: "border-red-500/30 bg-red-500/15 text-red-400",
  info: "border-blue-500/30 bg-blue-500/15 text-blue-400",
  discovery: "border-purple-500/30 bg-purple-500/15 text-purple-400",
  secondary: "border-border bg-muted text-muted-foreground",
};

const BADGE_SOLID_COLORS: Record<string, string> = {
  success: "border-transparent bg-emerald-600 text-white",
  warning: "border-transparent bg-amber-600 text-white",
  danger: "border-transparent bg-red-600 text-white",
  info: "border-transparent bg-blue-600 text-white",
  discovery: "border-transparent bg-purple-600 text-white",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
};

const BADGE_OUTLINE_COLORS: Record<string, string> = {
  success: "border-emerald-500/50 bg-transparent text-emerald-400",
  warning: "border-amber-500/50 bg-transparent text-amber-400",
  danger: "border-red-500/50 bg-transparent text-red-400",
  info: "border-blue-500/50 bg-transparent text-blue-400",
  discovery: "border-purple-500/50 bg-transparent text-purple-400",
  secondary: "border-border bg-transparent text-foreground",
};

function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      tokens.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      tokens.push(
        <strong key={key++} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      tokens.push(
        <em key={key++} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      tokens.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (m && isSafeHttpUrl(m[2])) {
        tokens.push(
          <a
            key={key++}
            href={m[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:opacity-80"
          >
            {m[1]}
          </a>,
        );
      } else {
        tokens.push(token);
      }
    }
    lastIdx = match.index + token.length;
  }

  if (lastIdx < text.length) {
    tokens.push(text.slice(lastIdx));
  }
  return tokens;
}

function renderSafeMarkdown(markdown: string): ReactNode {
  const blocks = markdown.split(/\n{2,}/);
  return (
    <div className="space-y-1.5 text-sm leading-6 text-foreground">
      {blocks.map((block, bIdx) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={bIdx} className="list-disc space-y-0.5 pl-5">
              {lines.map((l, lIdx) => (
                <li key={lIdx}>{renderInlineMarkdown(l.replace(/^\s*[-*]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        const headingMatch = /^(#{1,3})\s+(.+)$/.exec(block.trim());
        if (headingMatch && lines.length === 1) {
          return (
            <p key={bIdx} className="font-semibold text-foreground">
              {renderInlineMarkdown(headingMatch[2])}
            </p>
          );
        }
        return (
          <p key={bIdx} className="whitespace-pre-wrap break-words">
            {renderInlineMarkdown(block)}
          </p>
        );
      })}
    </div>
  );
}

function extractChildIds(
  props: Record<string, unknown>,
  model: SurfaceModelLike,
): string[] {
  const out: string[] = [];
  if (typeof props.child === "string") {
    out.push(props.child);
  }
  const children = resolveProp(props.children, model);
  if (Array.isArray(children)) {
    for (const id of children) {
      if (typeof id === "string") out.push(id);
    }
  }
  return out;
}

export function buildA2uiChartOption(
  rawProps: Record<string, unknown>,
  resolve: (v: unknown) => unknown = (v) => v,
): Record<string, unknown> {
  const chartTypeRaw = asString(resolve(rawProps.chartType ?? rawProps.type)).toLowerCase();
  const isDonut = chartTypeRaw === "donut";
  const isArea = chartTypeRaw === "area";
  const echartsType =
    chartTypeRaw === "pie" || isDonut
      ? "pie"
      : chartTypeRaw === "area"
        ? "line"
        : ["bar", "line", "scatter"].includes(chartTypeRaw)
          ? chartTypeRaw
          : "bar";

  const rawData = resolve(rawProps.data);
  const data = Array.isArray(rawData)
    ? rawData.filter((d): d is Record<string, unknown> => Boolean(d && typeof d === "object"))
    : [];
  const rawSeries = resolve(rawProps.series);
  const title = asString(resolve(rawProps.title));
  const xField = asString(resolve(rawProps.xKey)) || "name";
  const stacked = Boolean(resolve(rawProps.stacked));
  const format = asString(resolve(rawProps.format)).toLowerCase();
  const currency = asString(resolve(rawProps.currency)) || "$";
  const showValueLabels = Boolean(resolve(rawProps.showValueLabels));
  const yAxisRaw = resolve(rawProps.yAxis);
  const yAxisObj =
    yAxisRaw && typeof yAxisRaw === "object" ? (yAxisRaw as Record<string, unknown>) : null;
  const yAxisLabel = yAxisObj ? asString(resolve(yAxisObj.label)) : "";

  // Normalize series: string | { key, label?, color? }, or infer from data[0] keys
  const normalizedSeries: Array<{ key: string; label: string; color?: string }> = [];
  if (Array.isArray(rawSeries) && rawSeries.length > 0) {
    for (const s of rawSeries) {
      if (typeof s === "string" && s.trim()) {
        normalizedSeries.push({ key: s, label: s });
      } else if (s && typeof s === "object") {
        const sr = s as Record<string, unknown>;
        const key = asString(sr.key);
        if (key) {
          normalizedSeries.push({
            key,
            label: asString(sr.label) || key,
            ...(typeof sr.color === "string" && sr.color ? { color: sr.color } : {}),
          });
        }
      }
    }
  } else if (data.length > 0) {
    for (const k of Object.keys(data[0])) {
      if (k !== xField) {
        normalizedSeries.push({ key: k, label: k });
      }
    }
  }

  const isRatioPercent =
    format === "percent" &&
    data.length > 0 &&
    normalizedSeries.length > 0 &&
    data.every((row) =>
      normalizedSeries.every((s) => {
        const num = Number(row[s.key]);
        return Number.isFinite(num) && Math.abs(num) <= 1;
      }),
    );

  const formatNumericValue = (val: unknown): string => {
    const num = Number(val);
    if (!Number.isFinite(num)) return asString(val);
    if (format === "percent") {
      return `${Math.round(isRatioPercent ? num * 100 : num)}%`;
    }
    if (format === "currency") {
      return `${currency}${num.toLocaleString()}`;
    }
    return num.toLocaleString();
  };

  if (echartsType === "pie") {
    const valueKey = normalizedSeries[0]?.key ?? "value";
    const pieData = data.map((row) => ({
      name: asString(row[xField]),
      value: Number(row[valueKey] ?? 0),
    }));
    const radius = isDonut
      ? [
          (resolve(rawProps.innerRadius) as string | number | undefined) ?? "45%",
          (resolve(rawProps.outerRadius) as string | number | undefined) ?? "70%",
        ]
      : (resolve(rawProps.outerRadius) as string | number | undefined) ?? "65%";

    return {
      ...(title ? { title: { text: title, left: "center", textStyle: { fontSize: 13 } } } : {}),
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      series: [
        {
          type: "pie",
          radius,
          data: pieData,
        },
      ],
    };
  }

  const seriesList = normalizedSeries.map((s) => ({
    type: echartsType,
    name: s.label,
    ...(s.color ? { itemStyle: { color: s.color } } : {}),
    ...(isArea ? { areaStyle: {} } : {}),
    ...(stacked ? { stack: "total" } : {}),
    ...(showValueLabels
      ? {
          label: {
            show: true,
            position: "top",
            formatter: (params: { value?: Record<string, unknown> }) => {
              const rawVal = params?.value?.[s.key];
              return formatNumericValue(rawVal);
            },
          },
        }
      : {}),
    encode: { x: xField, y: s.key },
  }));

  return {
    ...(title ? { title: { text: title, textStyle: { fontSize: 13 } } } : {}),
    tooltip: { trigger: "axis" },
    legend: seriesList.length > 1 ? { bottom: 0 } : undefined,
    grid: {
      left: yAxisLabel ? 56 : 44,
      right: 16,
      top: title ? 36 : 20,
      bottom: seriesList.length > 1 ? 32 : 24,
    },
    dataset: { source: data },
    xAxis: { type: "category" },
    yAxis: {
      type: "value",
      ...(yAxisLabel
        ? { name: yAxisLabel, nameLocation: "middle", nameGap: 42 }
        : {}),
      ...(format === "percent" || format === "currency"
        ? { axisLabel: { formatter: (v: number) => formatNumericValue(v) } }
        : {}),
    },
    series: seriesList,
  };
}

function TabsView({
  props,
  model,
  renderNode,
}: {
  props: Record<string, unknown>;
  model: SurfaceModelLike;
  renderNode: (id: string) => ReactNode;
}): ReactElement {
  const rawTabs = resolveProp(props.tabs, model);
  const tabs = Array.isArray(rawTabs) ? rawTabs : [];
  const rawSelectedIdx = resolveProp(props.selectedIndex, model);
  const initialIdx =
    typeof rawSelectedIdx === "number" && Number.isFinite(rawSelectedIdx)
      ? Math.max(0, Math.floor(rawSelectedIdx))
      : 0;
  const [activeIdx, setActiveIdx] = useState(initialIdx);

  if (tabs.length === 0) return <></>;
  const safeIdx = Math.min(activeIdx, tabs.length - 1);
  const current = tabs[safeIdx] as Record<string, unknown> | undefined;
  const childId = typeof current?.child === "string" ? current.child : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1 border-b pb-1.5">
        {tabs.map((t, idx) => {
          const item = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
          const label = asString(resolveProp(item.title ?? item.label, model)) || `Tab ${idx + 1}`;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => setActiveIdx(idx)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                idx === safeIdx
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {childId ? <div>{renderNode(childId)}</div> : null}
    </div>
  );
}

export function A2uiBlockRenderer({ block, size = "compact" }: Props): ReactElement {
  const surface = useMemo(() => {
    const ui = createHeadlessCatalog(block.surface.catalogId);
    const manager = new GenerativeUISurfaceManager(ui);
    manager.ingest("outcome", undefined, block.surface);
    return (
      manager.getSurface("outcome", block.surface.surfaceId) ??
      manager.getFailedSurface("outcome", block.surface.surfaceId)
    );
  }, [block.surface]);

  if (!surface || surface.failed) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        Unable to render A2UI surface ({block.surface.surfaceId}).
      </div>
    );
  }

  const model = surface.model;
  const isLarge = size === "large";
  const rejectedCount =
    block.surface.rejected.length + surface.clientRejected.length;

  const renderNodeByType = (
    nodeType: string,
    props: Record<string, unknown>,
    childIds: string[],
    nextVisited: Set<string>,
  ): ReactNode => {
    const renderChildren = () =>
      childIds.map((cid) => <Fragment key={cid}>{renderComponent(cid, nextVisited)}</Fragment>);
    const justifyCls = JUSTIFY_CLASS_MAP[asString(resolveProp(props.justify, model))] ?? "";
    const alignCls = ALIGN_CLASS_MAP[asString(resolveProp(props.align, model))] ?? "";

    switch (nodeType) {
      case "Box":
      case "FlowItem":
      case "GridItem":
        return <div className={`min-w-0 ${justifyCls} ${alignCls}`.trim()}>{renderChildren()}</div>;

      case "Column":
        return (
          <div className={`flex flex-col gap-2.5 ${justifyCls} ${alignCls}`.trim()}>
            {renderChildren()}
          </div>
        );

      case "Row":
      case "Flow":
        return (
          <div
            className={`flex flex-wrap gap-2.5 ${alignCls || "items-center"} ${justifyCls}`.trim()}
          >
            {renderChildren()}
          </div>
        );

      case "Grid": {
        const cols = Number(resolveProp(props.columns, model)) || 2;
        const colClass =
          cols >= 4
            ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
            : cols === 3
              ? "grid-cols-1 sm:grid-cols-3"
              : "grid-cols-1 sm:grid-cols-2";
        return <div className={`grid gap-3 ${colClass}`}>{renderChildren()}</div>;
      }

      case "Card":
        return (
          <div className="rounded-lg border bg-card p-3.5 text-card-foreground shadow-xs">
            {renderChildren()}
          </div>
        );

      case "Tabs":
        return (
          <TabsView
            props={props}
            model={model}
            renderNode={(cid) => renderComponent(cid, nextVisited)}
          />
        );

      case "Divider":
        return <hr className="my-2 border-border" />;

      case "Spacer":
        return <div className="h-2" aria-hidden />;

      case "Title":
        return (
          <h4 className="text-sm font-semibold tracking-tight text-foreground">
            {asString(resolveProp(props.text, model))}
          </h4>
        );

      case "Text":
      case "Math":
        return (
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            {renderInlineMarkdown(asString(resolveProp(props.text ?? props.value, model)))}
          </p>
        );

      case "Markdown":
        return renderSafeMarkdown(asString(resolveProp(props.text ?? props.value, model)));

      case "Caption":
      case "Label":
        return (
          <span className="text-xs text-muted-foreground">
            {renderInlineMarkdown(asString(resolveProp(props.text ?? props.label, model)))}
          </span>
        );

      case "Bold":
        return <strong className="font-semibold">{asString(resolveProp(props.text, model))}</strong>;

      case "Italic":
        return <em className="italic">{asString(resolveProp(props.text, model))}</em>;

      case "Underline":
        return <span className="underline">{asString(resolveProp(props.text, model))}</span>;

      case "Strikethrough":
        return <span className="line-through">{asString(resolveProp(props.text, model))}</span>;

      case "Badge": {
        const badgeColor = asString(resolveProp(props.color ?? props.tone, model)).toLowerCase() || "secondary";
        const badgeVariant = asString(resolveProp(props.variant, model)).toLowerCase() || "soft";
        const isPill = Boolean(resolveProp(props.pill, model));
        const palette =
          badgeVariant === "solid"
            ? BADGE_SOLID_COLORS
            : badgeVariant === "outline"
              ? BADGE_OUTLINE_COLORS
              : BADGE_SOFT_COLORS;
        const colorCls = palette[badgeColor] ?? palette.secondary;
        return (
          <span
            className={`inline-flex items-center border px-2 py-0.5 text-xs font-medium ${
              isPill ? "rounded-full" : "rounded-md"
            } ${colorCls}`}
          >
            {asString(resolveProp(props.label ?? props.text, model))}
          </span>
        );
      }

      case "Blockquote":
        return (
          <blockquote className="border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
            {asString(resolveProp(props.text, model))}
          </blockquote>
        );

      case "Code":
        return (
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
            <code>{asString(resolveProp(props.code ?? props.text, model))}</code>
          </pre>
        );

      case "Link": {
        const href = resolveProp(props.href ?? props.url, model);
        const label = asString(resolveProp(props.text ?? props.label, model)) || String(href ?? "");
        if (!isSafeHttpUrl(href)) {
          return <span className="text-sm text-muted-foreground">{label}</span>;
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary underline underline-offset-2 hover:opacity-80"
          >
            {label}
          </a>
        );
      }

      case "Table": {
        const rows = resolveProp(props.rows, model);
        const columns = resolveProp(props.columns, model);
        const caption = asString(resolveProp(props.caption, model));
        if (Array.isArray(rows)) {
          const cols = Array.isArray(columns) ? columns : [];
          const emptyLabel = asString(resolveProp(props.emptyLabel, model)) || "No data";
          return (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-left text-xs">
                {caption ? (
                  <caption className="px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground">
                    {caption}
                  </caption>
                ) : null}
                {cols.length > 0 ? (
                  <thead className="bg-muted/50 font-medium">
                    <tr className="border-b border-border">
                      {cols.map((col, idx) => {
                        const c =
                          typeof col === "string"
                            ? { label: col }
                            : ((col && typeof col === "object" ? col : {}) as Record<string, unknown>);
                        const align =
                          c.align === "end"
                            ? "text-right"
                            : c.align === "center"
                              ? "text-center"
                              : "text-left";
                        return (
                          <th key={idx} className={`px-2.5 py-1.5 font-medium ${align}`}>
                            {asString(resolveProp(c.label, model))}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                ) : null}
                <tbody className="divide-y divide-border">
                  {rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={Math.max(cols.length, 1)}
                        className="px-2.5 py-3 text-center text-muted-foreground"
                      >
                        {emptyLabel}
                      </td>
                    </tr>
                  ) : (
                    rows.map((r, rIdx) => {
                      const cells = Array.isArray(r) ? r : [];
                      return (
                        <tr key={rIdx} className="border-b border-border last:border-b-0">
                          {cells.map((cell, cIdx) => {
                            const resolved = resolveProp(cell, model);
                            let renderedCell: ReactNode = null;

                            if (
                              typeof resolved === "string" &&
                              model.componentsModel.get(resolved)
                            ) {
                              renderedCell = renderComponent(resolved, nextVisited);
                            } else if (
                              resolved &&
                              typeof resolved === "object" &&
                              !Array.isArray(resolved)
                            ) {
                              const obj = resolved as Record<string, unknown>;
                              const refId =
                                typeof obj.componentId === "string"
                                  ? obj.componentId
                                  : typeof obj.id === "string"
                                    ? obj.id
                                    : null;
                              if (refId && model.componentsModel.get(refId)) {
                                renderedCell = renderComponent(refId, nextVisited);
                              } else if (typeof obj.component === "string") {
                                renderedCell = renderNodeByType(
                                  obj.component,
                                  obj,
                                  extractChildIds(obj, model),
                                  nextVisited,
                                );
                              } else {
                                renderedCell = asString(resolved);
                              }
                            } else {
                              const colMeta =
                                cols[cIdx] && typeof cols[cIdx] === "object"
                                  ? (cols[cIdx] as Record<string, unknown>)
                                  : null;
                              const colCompId =
                                colMeta && typeof colMeta.componentId === "string"
                                  ? colMeta.componentId
                                  : null;
                              if (colCompId && model.componentsModel.get(colCompId)) {
                                renderedCell = renderComponent(colCompId, nextVisited);
                              } else {
                                renderedCell = asString(resolved);
                              }
                            }

                            return (
                              <td key={cIdx} className="px-2.5 py-1.5 align-middle text-foreground">
                                {renderedCell}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full border-collapse text-left text-xs">
              {renderChildren()}
            </table>
          </div>
        );
      }

      case "TableSection": {
        const variant = asString(resolveProp(props.variant, model)).toLowerCase();
        if (variant === "header" || variant === "head") {
          return <thead className="bg-muted/50 font-medium">{renderChildren()}</thead>;
        }
        return <tbody className="divide-y divide-border">{renderChildren()}</tbody>;
      }

      case "TableRow":
        return <tr className="border-b border-border last:border-b-0">{renderChildren()}</tr>;

      case "TableCell":
        return <td className="px-2.5 py-1.5 align-top text-foreground">{renderChildren()}</td>;

      case "List": {
        const items = resolveProp(props.items, model);
        const direction = asString(resolveProp(props.direction, model)).toLowerCase();
        const isHorizontal = direction === "horizontal";
        if (Array.isArray(items)) {
          return (
            <ul
              className={
                isHorizontal
                  ? "flex flex-wrap gap-3 text-sm"
                  : "list-disc space-y-1.5 pl-5 text-sm"
              }
            >
              {items.map((item, idx) => {
                if (typeof item === "string") {
                  return <li key={idx}>{item}</li>;
                }
                const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
                const label = asString(resolveProp(rec.label, model));
                const desc = asString(resolveProp(rec.description, model));
                const value = asString(resolveProp(rec.value, model));
                return (
                  <li key={idx} className="text-foreground">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium">{label}</span>
                      {value ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {value}
                        </span>
                      ) : null}
                    </div>
                    {desc ? (
                      <p className="text-xs text-muted-foreground">{desc}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          );
        }
        return <ul className="list-disc space-y-1 pl-5 text-sm">{renderChildren()}</ul>;
      }

      case "ListItem":
        return <li>{renderChildren()}</li>;

      case "Chart": {
        const option = buildA2uiChartOption(props, (v) => resolveProp(v, model));
        return (
          <div className={isLarge ? "h-[400px] w-full" : "h-[280px] w-full"}>
            <EChartsRenderer option={option} />
          </div>
        );
      }

      case "Image": {
        const src = resolveProp(props.src ?? props.url, model);
        const alt = asString(resolveProp(props.alt, model)) || "Image";
        if (!isSafeImageSrc(src)) return null;
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt}
            className="max-h-72 max-w-full rounded-md border object-contain"
          />
        );
      }

      case "HtmlView": {
        const html = asString(resolveProp(props.html, model));
        if (!html) return null;
        return (
          <iframe
            sandbox="allow-scripts"
            srcDoc={html}
            title="A2UI HTML View"
            className={`w-full rounded-md border bg-background ${isLarge ? "h-[420px]" : "h-[280px]"}`}
          />
        );
      }

      case "Button":
        return (
          <button
            type="button"
            disabled
            className="inline-flex h-8 items-center rounded-md border bg-muted px-3 text-xs font-medium text-muted-foreground opacity-70"
          >
            {asString(resolveProp(props.label ?? props.text, model)) || "Action"}
          </button>
        );

      case "TextField":
      case "TextArea":
      case "Select":
      case "CheckBox":
      case "Radio":
      case "RadioGroup":
      case "Slider":
      case "SegmentedControl":
      case "ChoicePicker":
      case "DateTimeInput":
      case "Form": {
        const label = asString(resolveProp(props.label ?? props.placeholder, model));
        return (
          <div className="rounded-md border border-dashed bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
            {label ? `${nodeType}: ${label}` : `${nodeType} (read-only preview)`}
            {childIds.length > 0 ? <div className="mt-1.5">{renderChildren()}</div> : null}
          </div>
        );
      }

      default:
        return (
          <span className="inline-flex items-center rounded border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground">
            [Component: {nodeType}]
          </span>
        );
    }
  };

  const renderComponent = (id: string, visited: Set<string>): ReactNode => {
    if (visited.has(id)) return null;
    const node = model.componentsModel.get(id);
    if (!node) return null;

    const nextVisited = new Set(visited);
    nextVisited.add(id);
    const props = (node.properties ?? {}) as Record<string, unknown>;
    const childIds = extractChildIds(props, model);
    return renderNodeByType(node.type, props, childIds, nextVisited);
  };

  const heightClass = isLarge ? "flex-1 h-full min-h-[480px]" : "h-[400px]";

  return (
    <div className={`${heightClass} w-full flex flex-col overflow-y-auto space-y-2`}>
      {rejectedCount > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          {rejectedCount} UI update(s) could not be rendered.
        </div>
      ) : null}
      {renderComponent(GENERATIVE_UI_ROOT_ID, new Set())}
    </div>
  );
}
