/**
 * Deterministic MCP tool namespacing for Built-in agents.
 *
 * Pure module (no `server-only` or `node:*` imports) so UI, testing tools,
 * workflow save-deps, and runtime dispatch share the exact same naming rules.
 *
 * CONTRACT: For a given `(group, name, serverId)` and `rawToolName`, the
 * generated agent-facing tool name is deterministic, independent of binding
 * order or tool-name collisions, matches `^[a-zA-Z0-9_-]+$`, and is <= 64 chars.
 */

import type { GracefulMcpProvider } from "./client-providers";

export const MAX_PREFIX_LENGTH = 24;
export const MAX_AGENT_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 6;

export const MCP_TOOL_META: unique symbol = Symbol.for("nango.mcpToolMeta");
export const MCP_TOOL_ANNOTATIONS: unique symbol = Symbol.for(
  "nango.mcpToolAnnotations",
);

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
}

export interface McpToolMeta {
  source: "mcp";
  mcpServerId: string;
  rawToolName: string;
  annotations?: McpToolAnnotations;
}

export interface McpServerNamespaceInput {
  serverId: string;
  group?: string | null;
  name: string;
}

/**
 * Pure-JS SHA-1 returning the first `length` base36 characters.
 * Avoids `node:crypto` so this module stays browser-safe.
 */
function sha1Base36(input: string, length: number): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;

  // Pad to 64-byte (512-bit) blocks: data + 0x80 + zeros + 8-byte big-endian length
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Int32Array(80);
  const rotl = (n: number, s: number) => (n << s) | (n >>> (32 - s));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getInt32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const part0 = (h0 >>> 0).toString(36).padStart(7, "0");
  const part1 = (h1 >>> 0).toString(36).padStart(7, "0");
  return `${part0}${part1}`.slice(0, length);
}

function sanitizeIdentifierSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
}

/**
 * Build a deterministic, identifier-safe prefix (<= 24 chars) for an MCP server
 * from its `group`, `name`, and `serverId`.
 */
export function buildMcpToolPrefix(input: McpServerNamespaceInput): string {
  const parts = [input.group?.trim() ?? "", input.name.trim()].filter(
    (part) => part.length > 0,
  );
  const rawJoined = parts.join("_");
  const sanitized = sanitizeIdentifierSegment(rawJoined);

  if (sanitized.length === 0) {
    const idPrefix = input.serverId.replace(/[^A-Za-z0-9]/g, "").slice(0, 6) || "server";
    return `mcp-${idPrefix}`;
  }

  if (sanitized.length <= MAX_PREFIX_LENGTH) {
    return sanitized;
  }

  const headLen = MAX_PREFIX_LENGTH - 1 - HASH_SUFFIX_LENGTH; // 17
  const head = sanitized.slice(0, headLen).replace(/[_-]+$/g, "") || sanitized.slice(0, headLen);
  const hash = sha1Base36(rawJoined, HASH_SUFFIX_LENGTH);
  return `${head}-${hash}`;
}

/**
 * Resolve prefixes for all MCP servers bound to one agent.
 * When multiple servers produce the same base prefix, sort by `serverId` and
 * append `-${serverId.slice(0, 4)}` from the second server onward while
 * keeping every prefix within `MAX_PREFIX_LENGTH`.
 */
export function resolveAgentMcpPrefixes(
  servers: ReadonlyArray<McpServerNamespaceInput>,
): Map<string, string> {
  const result = new Map<string, string>();
  const byBasePrefix = new Map<string, McpServerNamespaceInput[]>();

  for (const server of servers) {
    const base = buildMcpToolPrefix(server);
    const list = byBasePrefix.get(base);
    if (list) {
      list.push(server);
    } else {
      byBasePrefix.set(base, [server]);
    }
  }

  for (const [base, group] of byBasePrefix.entries()) {
    if (group.length === 1) {
      result.set(group[0].serverId, base);
      continue;
    }

    const sorted = [...group].sort((a, b) =>
      a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0,
    );

    result.set(sorted[0].serverId, base);
    const used = new Set<string>([base]);

    for (let i = 1; i < sorted.length; i++) {
      const server = sorted[i];
      const idCompact = server.serverId.replace(/[^A-Za-z0-9]/g, "");
      const suffix = idCompact.slice(0, 4) || String(i);
      const maxHeadLen = MAX_PREFIX_LENGTH - 1 - suffix.length;
      const head = base.slice(0, maxHeadLen).replace(/[_-]+$/g, "") || base.slice(0, maxHeadLen);
      let candidate = `${head}-${suffix}`;

      if (used.has(candidate)) {
        const fallbackHash = sha1Base36(`${server.serverId}:${i}`, 4);
        const fallbackHead = base.slice(0, MAX_PREFIX_LENGTH - 5).replace(/[_-]+$/g, "");
        candidate = `${fallbackHead || "mcp"}-${fallbackHash}`;
      }

      used.add(candidate);
      result.set(server.serverId, candidate);
    }
  }

  return result;
}

/**
 * Combine an MCP server prefix and raw tool name into the agent-facing name.
 * Always matches `^[a-zA-Z0-9_-]+$` and length <= 64.
 */
export function toAgentToolName(prefix: string, rawToolName: string): string {
  const safeRaw = sanitizeIdentifierSegment(rawToolName) || "tool";
  const candidate = `${prefix}_${safeRaw}`;
  if (candidate.length <= MAX_AGENT_TOOL_NAME_LENGTH) {
    return candidate;
  }

  const hash = sha1Base36(rawToolName, HASH_SUFFIX_LENGTH);
  const maxRawLen =
    MAX_AGENT_TOOL_NAME_LENGTH - prefix.length - 1 - 1 - HASH_SUFFIX_LENGTH;
  const truncatedRaw =
    safeRaw.slice(0, Math.max(1, maxRawLen)).replace(/[_-]+$/g, "") ||
    safeRaw.slice(0, Math.max(1, maxRawLen));
  return `${prefix}_${truncatedRaw}-${hash}`;
}

/**
 * Read MCP origin metadata attached by {@link namespaceMcpProvider}.
 */
export function getMcpToolMeta(tool: unknown): McpToolMeta | undefined {
  if (!tool || typeof tool !== "object") return undefined;
  return (tool as Record<symbol, McpToolMeta | undefined>)[MCP_TOOL_META];
}

/**
 * Wrap a {@link GracefulMcpProvider} so `tools()` exposes agent-facing
 * namespaced keys and attaches {@link MCP_TOOL_META} to each tool object.
 * Upstream `execute` closures remain untouched and still send `rawToolName`.
 */
export function namespaceMcpProvider(
  provider: GracefulMcpProvider,
  opts: { serverId: string; prefix: string },
): GracefulMcpProvider {
  return {
    get label() {
      return provider.label;
    },
    get health() {
      return provider.health;
    },
    get lastErrorMessage() {
      return provider.lastErrorMessage;
    },
    close() {
      return provider.close();
    },
    async tools() {
      const rawTools = (await provider.tools()) as Record<string, unknown>;
      const namespaced: Record<string, unknown> = {};

      for (const [rawToolName, tool] of Object.entries(rawTools)) {
        if (!tool || typeof tool !== "object") continue;
        const agentToolName = toAgentToolName(opts.prefix, rawToolName);
        const annotations = (
          tool as Record<symbol, McpToolAnnotations | undefined>
        )[MCP_TOOL_ANNOTATIONS];
        const meta: McpToolMeta = {
          source: "mcp",
          mcpServerId: opts.serverId,
          rawToolName,
          ...(annotations ? { annotations } : {}),
        };
        namespaced[agentToolName] = {
          ...(tool as Record<string, unknown>),
          name: agentToolName,
          [MCP_TOOL_META]: meta,
        };
      }

      return namespaced as never;
    },
  };
}
