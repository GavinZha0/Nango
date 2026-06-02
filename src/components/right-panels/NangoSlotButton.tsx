"use client";

/**
 * NangoSlotButton — replaces CopilotKit's default `+` button with Nango entry-point menu.
 */

import type { ReactNode, ButtonHTMLAttributes } from "react";
import { ArrowLeft, Check, Sparkles, Workflow } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ORCHESTRATION_MODES,
  type OrchestrationModeId,
} from "@/lib/orchestration/modes";
import { useWorkspaceStore } from "@/store/workspace";

/** Accepts CopilotKit slot props for drop-in compatibility; swallows unused fields. */
interface NangoSlotButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  toolsMenu?: unknown;
  onAddFile?: () => void;
}

const PURPLE_BTN_BASE =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium "
  + "transition-colors focus-visible:outline-none focus-visible:ring-1 "
  + "focus-visible:ring-purple-400";

// Amber = chatting with Nango; purple = can switch to Nango.
const NANGO_ACTIVE =
  "bg-amber-500/60 text-amber-950 hover:bg-amber-500/80 "
  + "dark:bg-amber-500/60 dark:text-amber-100 dark:hover:bg-amber-500/80";

const PURPLE_GHOST =
  "text-purple-700 hover:bg-purple-500/10 "
  + "dark:text-purple-300 dark:hover:bg-purple-500/15";

const PURPLE_DISABLED =
  "text-purple-500/40 cursor-not-allowed";

// `_props` is intentionally unused — the underscore prefix marks it as a
// shape-parity placeholder for slot consumers that pass props by name.
export function NangoSlotButton(_props: NangoSlotButtonProps): ReactNode {
  const builtinAgents = useWorkspaceStore((s) => s.builtinAgents);
  const activeAgentId = useWorkspaceStore((s) => s.activeAgentId);
  const activeAgentSource = useWorkspaceStore((s) => s.activeAgentSource);
  const previousAgent = useWorkspaceStore((s) => s.previousAgent);
  const activeMode = useWorkspaceStore((s) => s.activeMode);
  const setActiveMode = useWorkspaceStore((s) => s.setActiveMode);
  const enterNango = useWorkspaceStore((s) => s.enterNango);
  const exitNango = useWorkspaceStore((s) => s.exitNango);

  const supervisor = builtinAgents.find(
    (a) => a.role === "supervisor" && a.enabled,
  );

  const isOnNango =
    activeAgentSource === "builtin"
    && supervisor !== undefined
    && activeAgentId === supervisor.id;

  // Case 1: no supervisor configured
  if (!supervisor) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled
              className={cn(PURPLE_BTN_BASE, PURPLE_DISABLED)}
              aria-label="Ask Nango (no supervisor configured)"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Ask Nango
            </button>
          }
        />
        <TooltipContent>
          No Nango configured. Designate a built-in agent as your
          supervisor in the Agent panel to enable this shortcut.
        </TooltipContent>
      </Tooltip>
    );
  }

  // Case 2: not on Nango — single-click switch
  if (!isOnNango) {
    return (
      <button
        type="button"
        onClick={() => enterNango({ id: supervisor.id })}
        className={cn(PURPLE_BTN_BASE, PURPLE_GHOST)}
        title={`Switch to ${supervisor.name} — your supervisor agent`}
      >
        <Sparkles className="h-3.5 w-3.5" />
        Ask Nango
      </button>
    );
  }

  // Case 3: on Nango — dropdown for mode + back-to-previous
  const activeModeMeta =
    ORCHESTRATION_MODES.find((m) => m.id === activeMode) ?? ORCHESTRATION_MODES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={cn(PURPLE_BTN_BASE, NANGO_ACTIVE)}
            aria-label={`Active: ${supervisor.name} — mode ${activeModeMeta.label}`}
            title={`Mode: ${activeModeMeta.label}`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Nango
          </button>
        }
      />
      <DropdownMenuContent align="start" side="top" className="w-64">
        {/* Mode picker */}
        <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <Workflow className="mr-1 inline h-3 w-3" />
          Orchestration mode
        </div>
        {ORCHESTRATION_MODES.map((mode) => {
          const isSelected = mode.id === activeMode;
          return (
            <DropdownMenuItem
              key={mode.id}
              onClick={() => setActiveMode(mode.id as OrchestrationModeId)}
              className="flex items-start gap-2 py-2 pl-2 pr-2"
            >
              <div className="min-w-0 flex-1">
                <span
                  className={cn(
                    "text-xs",
                    isSelected ? "font-semibold" : "font-medium",
                  )}
                >
                  {mode.label}
                </span>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {mode.description}
                </p>
              </div>
              {isSelected && (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
            </DropdownMenuItem>
          );
        })}

        {/* Back to previous (only when there's a breadcrumb) */}
        {previousAgent && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => exitNango()} className="gap-2 text-xs">
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to {previousAgent.name ?? "previous agent"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
