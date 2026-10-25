"use client";

/**
 * /kb/[id] — center workspace editor for one knowledge collection.
 *
 * There is no `/kb/new`: the left panel creates the empty collection through a
 * dialog and routes here, because a collection with no groups or pages has
 * nothing this pane could edit.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { mutate as globalMutate } from "swr";

import { KbEditor } from "@/components/main-panels/KbEditor";
import { KB_LIST_KEY } from "@/components/left-panels/KbPanel";
import type { KbTreeDetail } from "@/lib/types/kb";

export default function KbEditorPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [detail, setDetail] = useState<KbTreeDetail | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/kb/${id}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            message?: string;
            error?: string;
          } | null;
          throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
        }
        const d = (await res.json()) as KbTreeDetail;
        if (!cancelled) setDetail(d);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return <p className="px-8 py-10 text-xs text-muted-foreground">Loading…</p>;
  }
  if (error) {
    return <p className="px-8 py-10 text-xs text-destructive">{error}</p>;
  }
  if (!detail) {
    return (
      <p className="px-8 py-10 text-xs text-muted-foreground">
        Knowledge collection not found.
      </p>
    );
  }

  return (
    // Remount on id change so the editor's tree state never spans collections.
    <KbEditor
      key={detail.id}
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
