"use client";

/**
 * A2uiPreviewCard — compact inline chat card for `generative-ui-surface`
 * activity messages. Matches `HtmlPreviewCard` styling so generated UIs
 * open in `/outcomes` with a single click.
 */

import { ArrowUpRight, Code2, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactElement } from "react";
import type { GenerativeUISurfaceContent } from "@copilotkit/shared/generative-ui";

import {
  deriveSurfaceOutcomeId,
  extractSurfaceTitle,
} from "@/lib/generative-ui/surface";
import { useOutcomeStore } from "@/store/outcome-store";

export interface A2uiPreviewCardProps {
  activityType: string;
  content: GenerativeUISurfaceContent;
  message: { id: string; role?: string };
}

export function A2uiPreviewCard({ content }: A2uiPreviewCardProps): ReactElement {
  const router = useRouter();
  const select = useOutcomeStore((s) => s.select);

  const outcomeId = deriveSurfaceOutcomeId(content.surfaceId);
  const title = extractSurfaceTitle(content);
  const isStreaming = content.status === "streaming";
  const rejectedCount = content.rejected?.length ?? 0;

  const handleView = (): void => {
    router.push("/outcomes");
    select(outcomeId);
  };

  if (isStreaming) {
    return (
      <div className="my-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" aria-hidden />
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 min-w-0">
      <div className="flex flex-col w-full flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 shrink-0 text-blue-500" aria-hidden />
          <button
            type="button"
            onClick={handleView}
            className="inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
            aria-label={`View ${title} in Outcomes`}
          >
            {title}
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </button>
        </div>
        {rejectedCount > 0 ? (
          <p className="mt-1 text-xs text-amber-500">
            {rejectedCount} UI update(s) could not be applied
          </p>
        ) : null}
      </div>
    </div>
  );
}
