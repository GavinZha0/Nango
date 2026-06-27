/**
 * localStorage-backed input snapshots for the MCP tool test page.
 *
 * Every successful tool execution auto-saves its args as a snapshot.
 * Pinned snapshots are protected from eviction; unpinned ones rotate
 * out when the list exceeds MAX_SNAPSHOTS.
 * Scoped per (serverId, toolName).
 */

const PREFIX = "nango:mcp-snapshot";
const MAX_SNAPSHOTS = 20;

export interface ToolExecutionSnapshot {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  pinned?: boolean;
}

function storageKey(serverId: string, toolName: string): string {
  return `${PREFIX}:${serverId}:${toolName}`;
}

/** Read all snapshots for a tool (pinned first, then newest first). */
export function loadSnapshots(serverId: string, toolName: string): ToolExecutionSnapshot[] {
  try {
    const raw = localStorage.getItem(storageKey(serverId, toolName));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ToolExecutionSnapshot[];
  } catch {
    return [];
  }
}

function persist(serverId: string, toolName: string, list: ToolExecutionSnapshot[]): void {
  try {
    localStorage.setItem(storageKey(serverId, toolName), JSON.stringify(list));
  } catch (err) {
    console.warn("Failed to save MCP snapshot to localStorage:", err);
  }
}

/**
 * Save a new snapshot. Evicts the oldest **unpinned** entry when the
 * list exceeds MAX_SNAPSHOTS. Pinned entries are never evicted.
 */
export function saveSnapshot(
  serverId: string,
  toolName: string,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): ToolExecutionSnapshot {
  let finalResult = result;
  try {
    const stringified = JSON.stringify(result);
    if (stringified.length > 24576) {
      finalResult = { truncated_preview: stringified.slice(0, 24000) };
    }
  } catch {
    finalResult = { truncated_preview: "Unserializable result" };
  }

  const entry: ToolExecutionSnapshot = { id: crypto.randomUUID(), name, args, result: finalResult };
  const existing = loadSnapshots(serverId, toolName);
  const list = [entry, ...existing];
  // Evict oldest unpinned entries beyond the cap.
  while (list.length > MAX_SNAPSHOTS) {
    const idx = list.findLastIndex((s) => !s.pinned);
    if (idx === -1) break; // all pinned — don't evict
    list.splice(idx, 1);
  }
  persist(serverId, toolName, list);
  return entry;
}

/** Toggle the pinned state of a snapshot. */
export function togglePin(serverId: string, toolName: string, id: string): void {
  const list = loadSnapshots(serverId, toolName).map((s) =>
    s.id === id ? { ...s, pinned: !s.pinned } : s,
  );
  // Re-sort: pinned first, then by original order (insertion order).
  const pinned = list.filter((s) => s.pinned);
  const unpinned = list.filter((s) => !s.pinned);
  persist(serverId, toolName, [...pinned, ...unpinned]);
}
