"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { mutate as globalMutate } from "swr";

import {
  SkillEditor,
  type SkillDetail,
} from "@/components/main-panels/SkillEditor";
import { SKILLS_LIST_KEY } from "@/components/left-panels/SkillsPanel";

/**
 * /skills/[id] — center workspace editor for one skill.
 */

export default function SkillEditorPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";

  const [detail, setDetail] = useState<SkillDetail | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!isNew);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/skills/${id}`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            (body && (body.message ?? body.error)) ?? `HTTP ${res.status}`,
          );
        }
        const d = (await res.json()) as SkillDetail;
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
  }, [id, isNew]);

  if (!isNew && loading) {
    return (
      <p className="px-8 py-10 text-xs text-muted-foreground">Loading…</p>
    );
  }
  if (!isNew && error) {
    return <p className="px-8 py-10 text-xs text-destructive">{error}</p>;
  }

  return (
    <SkillEditor
      key={detail?.id ?? (isNew ? "new" : `pending-${id}`)}
      skillId={isNew ? null : id}
      initialDetail={detail}
      onBack={() => router.push("/skills")}
      // The skills list lives in the left panel's SWR cache, and the panel
      // stays mounted across these routes, so every write here has to
      // invalidate it. Kicked off without awaiting to keep navigation
      // snappy; the panel re-renders when the refetch lands.
      onSaved={() => {
        void globalMutate(SKILLS_LIST_KEY);
        router.push("/skills");
      }}
      onDeleted={() => {
        void globalMutate(SKILLS_LIST_KEY);
        router.push("/skills");
      }}
    />
  );
}
