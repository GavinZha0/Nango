"use client";

/**
 * /kb/[id] — center workspace editor for one knowledge collection.
 *
 * There is no `/kb/new`: the left panel creates the empty collection through a
 * dialog and routes here, because a collection with no pages has
 * nothing this pane could edit.
 */

import { useParams, useRouter } from "next/navigation";
import useSWR, { mutate as globalMutate } from "swr";

import { KbEditor } from "@/components/main-panels/KbEditor";
import { KB_LIST_KEY, kbDetailKey } from "@/components/left-panels/KbPanel";
import type { KbCollectionDetail } from "@/lib/types/kb";

const fetcher = async (url: string): Promise<KbCollectionDetail> => {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as KbCollectionDetail;
};

export default function KbEditorPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  // SWR, not a one-shot effect: an overwrite import from the left panel
  // revalidates this key while the route id stays the same, and the editor
  // below remounts off the fresh updatedAt. Focus revalidation stays off so a
  // refetch can never remount mid-edit and drop an unsaved draft.
  const { data: detail, error: fetchError, isLoading } = useSWR(
    id ? kbDetailKey(id) : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  if (isLoading) {
    return <p className="px-8 py-10 text-xs text-muted-foreground">Loading…</p>;
  }
  if (fetchError) {
    return (
      <p className="px-8 py-10 text-xs text-destructive">
        {fetchError instanceof Error ? fetchError.message : String(fetchError)}
      </p>
    );
  }
  if (!detail) {
    return (
      <p className="px-8 py-10 text-xs text-muted-foreground">
        Knowledge base not found.
      </p>
    );
  }

  return (
    // Remount on id change so the editor's tree state never spans collections,
    // and on updatedAt change so an external overwrite replaces the whole tree.
    <KbEditor
      key={`${detail.id}:${detail.updatedAt}`}
      initialDetail={detail}
      onBack={() => router.push("/kb")}
      // The list lives in the left panel's SWR cache and the panel stays
      // mounted across these routes, so every write here invalidates it —
      // page counts change with group/page writes, not just collection saves.
      onChanged={() => void globalMutate(KB_LIST_KEY)}
      onDeleted={() => {
        void globalMutate(KB_LIST_KEY);
        router.push("/kb");
      }}
    />
  );
}
