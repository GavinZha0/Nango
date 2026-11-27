/**
 * Shared token-usage extraction, aggregation, and display formatting.
 *
 * Pure module (no `server-only` or React imports) so server persistence,
 * `/connect` replay, Trace APIs, and chat/trace UI components all share
 * the exact same aggregation and formatting rules.
 */

export interface TokenUsageSummary {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens?: number | null;
  cachedInputTokens?: number | null;
}

export interface RawAgUiTokenUsageEntry {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

function readTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/**
 * Derive totalTokens when a provider reports input + output but omits total.
 */
function resolveTotal(
  inputTokens: number | null,
  outputTokens: number | null,
  totalTokens: number | null,
): number | null {
  if (totalTokens !== null) return totalTokens;
  if (inputTokens !== null && outputTokens !== null) {
    return inputTokens + outputTokens;
  }
  return null;
}

/**
 * Extract and sum AG-UI `RunFinishedEvent.usage` entries into a single
 * {@link TokenUsageSummary}. Returns `null` when no valid token count exists.
 */
export function summarizeRunUsage(rawUsage: unknown): TokenUsageSummary | null {
  if (!Array.isArray(rawUsage) || rawUsage.length === 0) return null;

  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let cachedInputTokens: number | null = null;

  for (const item of rawUsage) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const inp = readTokenCount(rec.inputTokens);
    const out = readTokenCount(rec.outputTokens);
    const tot = resolveTotal(inp, out, readTokenCount(rec.totalTokens));
    const reas = readTokenCount(rec.reasoningTokens);
    const cached = readTokenCount(rec.cachedInputTokens);

    inputTokens = addNullable(inputTokens, inp);
    outputTokens = addNullable(outputTokens, out);
    totalTokens = addNullable(totalTokens, tot);
    reasoningTokens = addNullable(reasoningTokens, reas);
    cachedInputTokens = addNullable(cachedInputTokens, cached);
  }

  const resolvedTotal = resolveTotal(inputTokens, outputTokens, totalTokens);
  if (
    inputTokens === null &&
    outputTokens === null &&
    resolvedTotal === null &&
    reasoningTokens === null &&
    cachedInputTokens === null
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: resolvedTotal,
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

/**
 * Merge multiple {@link TokenUsageSummary} objects (e.g. runs in a chat turn
 * or runs in a trace). Returns `null` if all inputs are null/empty.
 */
export function mergeTokenUsage(
  items: ReadonlyArray<TokenUsageSummary | null | undefined>,
): TokenUsageSummary | null {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let cachedInputTokens: number | null = null;

  for (const item of items) {
    if (!item) continue;
    const inp = readTokenCount(item.inputTokens);
    const out = readTokenCount(item.outputTokens);
    const tot = resolveTotal(inp, out, readTokenCount(item.totalTokens));
    const reas = readTokenCount(item.reasoningTokens);
    const cached = readTokenCount(item.cachedInputTokens);

    inputTokens = addNullable(inputTokens, inp);
    outputTokens = addNullable(outputTokens, out);
    totalTokens = addNullable(totalTokens, tot);
    reasoningTokens = addNullable(reasoningTokens, reas);
    cachedInputTokens = addNullable(cachedInputTokens, cached);
  }

  const resolvedTotal = resolveTotal(inputTokens, outputTokens, totalTokens);
  if (
    inputTokens === null &&
    outputTokens === null &&
    resolvedTotal === null
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: resolvedTotal,
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

/**
 * Build a minimal AG-UI `usage` array from persisted DB columns when a
 * run's `finished` event payload does not carry one.
 */
export function toAgUiUsageEntries(
  summary: TokenUsageSummary | null | undefined,
): RawAgUiTokenUsageEntry[] | undefined {
  if (!summary) return undefined;
  const entry: RawAgUiTokenUsageEntry = {};
  if (summary.inputTokens !== null) entry.inputTokens = summary.inputTokens;
  if (summary.outputTokens !== null) entry.outputTokens = summary.outputTokens;
  if (summary.totalTokens !== null) entry.totalTokens = summary.totalTokens;
  if (
    entry.inputTokens === undefined &&
    entry.outputTokens === undefined &&
    entry.totalTokens === undefined
  ) {
    return undefined;
  }
  return [entry];
}

/**
 * Format a token count compactly:
 * - `< 1,000`: exact integer (e.g. `610`)
 * - `1,000 .. 999,949`: `k` with 1 decimal (e.g. `1.2k`, `12.5k`; `.0` trimmed on `>= 100k`)
 * - `>= 1,000,000`: `M` with 1 decimal (e.g. `1.4M`)
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1_000) return String(Math.round(count));
  if (count < 999_950) {
    const k = count / 1_000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = count / 1_000_000;
  return `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * Compact directional display:
 * - Both input & output present -> `↑1.2k ↓610`
 * - Only one of input/output present -> `↑1.2k` or `↓610`
 * - Only totalTokens present -> `1.8k` (no arrows)
 * - Nothing present -> `null`
 */
export function formatTokenPair(
  usage: TokenUsageSummary | null | undefined,
): string | null {
  if (!usage) return null;
  const { inputTokens, outputTokens, totalTokens } = usage;
  if (inputTokens !== null && outputTokens !== null) {
    return `↑${formatTokenCount(inputTokens)} ↓${formatTokenCount(outputTokens)}`;
  }
  if (inputTokens !== null) {
    return `↑${formatTokenCount(inputTokens)}`;
  }
  if (outputTokens !== null) {
    return `↓${formatTokenCount(outputTokens)}`;
  }
  if (totalTokens !== null) {
    return formatTokenCount(totalTokens);
  }
  return null;
}

/**
 * Summary display combining total + breakdown (for Trace Summary card):
 * - Total + input/output -> `1.8k (↑1.2k ↓610)`
 * - Only total -> `1.8k`
 * - Only input/output -> `↑1.2k ↓610`
 */
export function formatTokenSummary(
  usage: TokenUsageSummary | null | undefined,
): string | null {
  if (!usage) return null;
  const total = resolveTotal(
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
  );
  const pair =
    usage.inputTokens !== null && usage.outputTokens !== null
      ? `↑${formatTokenCount(usage.inputTokens)} ↓${formatTokenCount(usage.outputTokens)}`
      : null;
  if (total !== null && pair) {
    return `${formatTokenCount(total)} (${pair})`;
  }
  if (total !== null) {
    return formatTokenCount(total);
  }
  return formatTokenPair(usage);
}

/**
 * Exact breakdown for hover tooltips, e.g.
 * `Input: 1,240 · Output: 610 · Total: 1,850`
 */
export function formatTokenTooltip(
  usage: TokenUsageSummary | null | undefined,
): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.inputTokens !== null) {
    parts.push(`Input: ${usage.inputTokens.toLocaleString("en-US")}`);
  }
  if (usage.outputTokens !== null) {
    parts.push(`Output: ${usage.outputTokens.toLocaleString("en-US")}`);
  }
  const total = resolveTotal(
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
  );
  if (total !== null) {
    parts.push(`Total: ${total.toLocaleString("en-US")}`);
  }
  if (
    usage.cachedInputTokens !== undefined &&
    usage.cachedInputTokens !== null &&
    usage.cachedInputTokens > 0
  ) {
    parts.push(`Cached: ${usage.cachedInputTokens.toLocaleString("en-US")}`);
  }
  if (
    usage.reasoningTokens !== undefined &&
    usage.reasoningTokens !== null &&
    usage.reasoningTokens > 0
  ) {
    parts.push(`Reasoning: ${usage.reasoningTokens.toLocaleString("en-US")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
