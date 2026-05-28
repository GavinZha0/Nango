"use client";

import { useParams } from "next/navigation";

import { ArtifactDetail } from "@/components/main-panels/ArtifactDetail";

/** /artifact/[id] — center workspace detail view for a single
 *  artifact or folder. */
export default function ArtifactDetailPage(): React.ReactNode {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <ArtifactDetail artifactId={id} />;
}
