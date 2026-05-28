"use client";

import useSWR, { type KeyedMutator } from "swr";

import type { ArtifactEntity } from "@/lib/db/schema";

/**
 * Client-side mirror of the service-layer `ArtifactNode` shape. The
 * server-side type lives in `lib/artifacts/service.ts`, but that
 * file is `server-only`; we re-declare the shape here so client
 * components can use it without dragging the service module into
 * the browser bundle.
 *
 * Sibling order: `displayOrder ASC, createdAt ASC` (set by the
 * service's ORDER BY).
 */
export type ArtifactNode = ArtifactEntity & {
  children: ArtifactNode[];
};

interface TreeResponse {
  tree: ArtifactNode[];
}

const fetcher = async (url: string): Promise<TreeResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    const detail: string = (await res.json().catch(() => ({})))?.message
      ?? `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return res.json();
};

export interface UseArtifactTreeReturn {
  /** Nested roots. `undefined` while the first request is in flight. */
  tree: ArtifactNode[] | undefined;
  isLoading: boolean;
  error: Error | undefined;
  /** Trigger a re-fetch — call after every mutating API call so the
   *  panel + dialogs stay consistent without manual refresh. */
  mutate: KeyedMutator<TreeResponse>;
}

/**
 * SWR-backed reader for the current user's artifact tree.
 *
 * Single source of truth for the left-panel `ArtifactPanel`, the
 * `ArtifactFolderTreeSelect` shared picker (used by SaveOutcomeDialog
 * and the detail page's "Move to…" action), and the detail page's
 * breadcrumb.
 *
 * @see docs/artifact-dashboard-migration.md §11.2
 */
export function useArtifactTree(): UseArtifactTreeReturn {
  const { data, error, isLoading, mutate } = useSWR<TreeResponse>(
    "/api/artifacts/tree",
    fetcher,
    { revalidateOnFocus: false },
  );

  return {
    tree: data?.tree,
    isLoading,
    error: error as Error | undefined,
    mutate,
  };
}

/**
 * Flatten the nested tree into `{ id → node }` for fast lookup.
 * Handy for breadcrumb rendering and ancestry checks on the client.
 */
export function indexById(roots: ArtifactNode[]): Map<string, ArtifactNode> {
  const out: Map<string, ArtifactNode> = new Map();
  const visit = (node: ArtifactNode): void => {
    out.set(node.id, node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

/**
 * Walk from a node up to its root via `parentId`. Returns the path
 * inclusive of the node itself, with the root first. Returns an
 * empty array if the node is not found.
 */
export function pathOf(
  index: Map<string, ArtifactNode>,
  nodeId: string,
): ArtifactNode[] {
  const path: ArtifactNode[] = [];
  let cursor: ArtifactNode | undefined = index.get(nodeId);
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentId ? index.get(cursor.parentId) : undefined;
  }
  return path;
}
