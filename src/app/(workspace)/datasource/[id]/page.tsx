"use client";

/**
 * /datasource/[id] — center workspace editor for one data source.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { DataSourceEditor } from "@/components/main-panels/DataSourceEditor";

interface DataSourceDetail {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  credentialId: string;
  host: string;
  port: number;
  database: string;
  params: Record<string, string>;
  readOnly: boolean;
  tableAllowlist: string[] | null;
  tableDenylist: string[];
  enabled: boolean;
  visibility: string;
}

export default function DataSourceEditorPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";

  const [detail, setDetail] = useState<DataSourceDetail | undefined>(undefined);
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
        const res = await fetch(`/api/data-sources/${id}`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            (body && (body.message ?? body.error)) ?? `HTTP ${res.status}`,
          );
        }
        const d = (await res.json()) as DataSourceDetail;
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
    <DataSourceEditor
      key={detail?.id ?? (isNew ? "new" : `pending-${id}`)}
      dataSourceId={isNew ? null : id}
      initialDetail={detail}
      onBack={() => router.push("/datasource")}
      onSaved={() => router.push("/datasource")}
    />
  );
}
