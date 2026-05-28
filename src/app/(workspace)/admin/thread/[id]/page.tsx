"use client";

import { useParams } from "next/navigation";

import { ThreadDetailView } from "@/components/admin/ThreadDetailView";

export default function AdminThreadDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <ThreadDetailView threadId={id} />;
}
