"use client";

/**
 * /ssh-server/[id] — center workspace editor for one SSH server.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import {
  SshServerEditor,
  type SshServerDetail,
} from "@/components/main-panels/SshServerEditor";

export default function SshServerEditorPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";

  const [detail, setDetail] = useState<SshServerDetail | undefined>(undefined);
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
        const res = await fetch(`/api/ssh-servers/${id}`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            (body && (body.message ?? body.error)) ?? `HTTP ${res.status}`,
          );
        }
        const d = (await res.json()) as SshServerDetail;
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
    return <p className="px-8 py-10 text-xs text-muted-foreground">Loading…</p>;
  }
  if (!isNew && error) {
    return <p className="px-8 py-10 text-xs text-destructive">{error}</p>;
  }

  return (
    <SshServerEditor
      key={detail?.id ?? (isNew ? "new" : `pending-${id}`)}
      sshServerId={isNew ? null : id}
      initialDetail={detail}
      onBack={() => router.push("/ssh-server")}
      onSaved={() => router.push("/ssh-server")}
    />
  );
}
