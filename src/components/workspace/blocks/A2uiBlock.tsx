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

import { useMemo, useState, type ReactElement, type ReactNode } from "react";
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

function resolveProp(
  val: unknown,
  model: SurfaceModelLike,
): unknown {
  if (val === null || val === undefined) return val;
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

function asString(val: unknown): string {
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return "";
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
    encode: { x: xField, y: s.key },
  }));

  return {
    ...(title ? { title: { text: title, textStyle: { fontSize: 13 } } } : {}),
    tooltip: { trigger: "axis" },
    legend: seriesList.length > 1 ? { bottom: 0 } : undefined,
    grid: { left: 40, right: 16, top: title ? 36 : 16, bottom: seriesList.length > 1 ? 32 : 24 },
    dataset: { source: data },
    xAxis: { type: "category" },
    yAxis: { type: "value" },
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

  const renderComponent = (id: string, visited: Set<string>): ReactNode => {
    if (visited.has(id)) return null;
    const node = model.componentsModel.get(id);
    if (!node) return null;

    const nextVisited = new Set(visited);
    nextVisited.add(id);
    const props = (node.properties ?? {}) as Record<string, unknown>;
    const childIds = extractChildIds(props, model);
    const renderChildren = () =>
      childIds.map((cid) => <div key={cid}>{renderComponent(cid, nextVisited)}</div>);

    switch (node.type) {
      case "Box":
      case "FlowItem":
      case "GridItem":
        return <div className="min-w-0">{renderChildren()}</div>;

      case "Column":
        return <div className="flex flex-col gap-2.5">{renderChildren()}</div>;

      case "Row":
      case "Flow":
        return <div className="flex flex-wrap items-center gap-2.5">{renderChildren()}</div>;

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
      case "Markdown":
      case "Math":
        return (
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            {asString(resolveProp(props.text ?? props.value, model))}
          </p>
        );

      case "Caption":
      case "Label":
        return (
          <span className="text-xs text-muted-foreground">
            {asString(resolveProp(props.text, model))}
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

      case "Badge":
        return (
          <span className="inline-flex items-center rounded-md border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
            {asString(resolveProp(props.text ?? props.label, model))}
          </span>
        );

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
                          {cells.map((cell, cIdx) => (
                            <td key={cIdx} className="px-2.5 py-1.5 align-top text-foreground">
                              {asString(resolveProp(cell, model))}
                            </td>
                          ))}
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
            {label ? `${node.type}: ${label}` : `${node.type} (read-only preview)`}
            {childIds.length > 0 ? <div className="mt-1.5">{renderChildren()}</div> : null}
          </div>
        );
      }

      default:
        return (
          <span className="inline-flex items-center rounded border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground">
            [Component: {node.type}]
          </span>
        );
    }
  };

  return (
    <div className="space-y-2">
      {rejectedCount > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          {rejectedCount} UI update(s) could not be rendered.
        </div>
      ) : null}
      {renderComponent(GENERATIVE_UI_ROOT_ID, new Set())}
    </div>
  );
}
