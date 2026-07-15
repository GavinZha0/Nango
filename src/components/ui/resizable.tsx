"use client";

import { Grip } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { GroupProps, SeparatorProps } from "react-resizable-panels";
import { cn } from "@/lib/utils";

function ResizablePanelGroup({
  className,
  orientation = "horizontal",
  ...props
}: GroupProps) {
  return (
    <Group
      orientation={orientation}
      className={cn(
        "flex h-full w-full",
        orientation === "vertical" && "flex-col",
        className,
      )}
      {...props}
    />
  );
}

const ResizablePanel = Panel;

/**
 * Resize handle. Orientation-aware via `aria-orientation` set by
 * the underlying `Separator` from `react-resizable-panels`.
 */
function ResizableHandle({
  withHandle,
  className,
  ...props
}: SeparatorProps & {
  withHandle?: boolean;
}) {
  return (
    <Separator
      className={cn(
        // Base (horizontal group → vertical 1px bar)
        "relative flex w-px items-center justify-center bg-border",
        "after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-['']",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
        "[&[data-resize-handle-active]]:bg-ring",
        // Vertical group → horizontal 1px bar
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
        "aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:right-0",
        "aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:inset-y-auto",
        "aria-[orientation=horizontal]:after:-top-1 aria-[orientation=horizontal]:after:-bottom-1",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div
          className={cn(
            "z-10 flex items-center justify-center gap-0.5 rounded-sm border bg-border",
            "h-7 w-3 flex-col",
            "[[aria-orientation=horizontal]_&]:h-3 [[aria-orientation=horizontal]_&]:w-7 [[aria-orientation=horizontal]_&]:flex-row",
          )}
        >
          <Grip className="h-2.5 w-2.5" />
          <Grip className="h-2.5 w-2.5" />
        </div>
      )}
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
