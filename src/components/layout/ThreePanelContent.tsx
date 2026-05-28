"use client";

/**
 * ThreePanelContent — resizable three-panel layout.
 *
 * Two orthogonal pieces of state govern the left panel:
 *
 *   1. WHICH panel renders — derived from `usePathname()` via
 *      `resolveActivePanel`. URL is the single source of truth.
 *   2. WHETHER the panel is visible — a Zustand flag
 *      (`leftPanelOpen`). Independent of the URL so users can hide
 *      the panel for more main-panel space without losing the
 *      section context.
 *
 * The resizable panel is visible iff `activePanel !== null` AND
 * `leftPanelOpen`. Drag-resize on the left handle ONLY toggles the
 * `leftPanelOpen` flag — it does NOT navigate, because collapsing
 * for screen real estate isn't the same intent as leaving the
 * section. The one exception is "user drags open from 0 while the
 * URL has no active section": we navigate to the last visited
 * section so the freshly-expanded panel has content to show.
 *
 * The right panel mirrors the same `*PanelOpen` flag pattern. The
 * right panel has no URL representation by design (chat state is
 * agent-driven, not route-driven; see
 * `docs/copilotkit-provider-lifecycle.md` §6).
 */

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { usePanelRef } from "react-resizable-panels";
import type { PanelSize } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useSidebarStore } from "@/store/sidebar";
import { SidePanel } from "@/components/layout/SidePanel";
import { RightPanel } from "@/components/layout/RightPanel";
import {
  SIDEBAR_PANEL_REGISTRY,
  resolveActivePanel,
} from "@/components/layout/sidebar-panel-registry";

// Size constants

const LEFT_MIN_PX = "280px";
const LEFT_DEFAULT_PX = "360px";
const LEFT_MAX_PX = "540px";
const CENTER_MIN_PX = "400px";
const RIGHT_MIN_PX = "480px";
const RIGHT_DEFAULT_PX = "720px";

/** Fallback when the user drag-expands from collapsed but hasn't
 *  visited any panel route this session. `/dashboard` is the first
 *  user-visible panel and works for every role. */
const FALLBACK_PANEL_HREF = "/dashboard";

// Component

interface ThreePanelContentProps {
  children: ReactNode;
}

export function ThreePanelContent({ children }: ThreePanelContentProps) {
  const pathname = usePathname();
  const router = useRouter();
  const activeLeftPanel = resolveActivePanel(pathname);

  const leftPanelOpen = useSidebarStore((s) => s.leftPanelOpen);
  const setLeftPanelOpen = useSidebarStore((s) => s.setLeftPanelOpen);
  const rightPanelOpen = useSidebarStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useSidebarStore((s) => s.setRightPanelOpen);

  const leftPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();

  // Skip the first onResize calls (initial layout) to prevent auto-collapse
  const mountedRef = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => { mountedRef.current = true; }, 500);
    return () => clearTimeout(timer);
  }, []);

  // Track whether the left panel has ever been expanded this session.
  // On first open after refresh we use resize() (since defaultSize is
  // 0 and expand() would have no prior size to restore); subsequent
  // open/close cycles use expand() to honour the user's drag-resized width.
  const leftEverExpandedRef = useRef(false);

  // Remember the last panel URL the user visited so a drag-expand
  // from collapsed (while the URL is at `/`) can restore it. Updated
  // whenever the pathname resolves to a known panel. Initial value
  // falls back to `/dashboard` for first-session-ever drags.
  const lastPanelHrefRef = useRef<string>(FALLBACK_PANEL_HREF);
  useEffect(() => {
    if (activeLeftPanel) {
      lastPanelHrefRef.current = SIDEBAR_PANEL_REGISTRY[activeLeftPanel].href;
    }
  }, [activeLeftPanel]);

  // Sync the resizable panel's collapsed/expanded state with
  // (activePanel from URL) AND (leftPanelOpen from store). Both have
  // to be true for the panel to show — that's the design contract.
  const shouldShowLeftPanel = activeLeftPanel !== null && leftPanelOpen;
  useEffect(() => {
    const panel = leftPanelRef.current;
    if (!panel) return;

    if (shouldShowLeftPanel && panel.isCollapsed()) {
      if (!leftEverExpandedRef.current) {
        panel.resize(LEFT_DEFAULT_PX);
        leftEverExpandedRef.current = true;
      } else {
        panel.expand();
      }
    } else if (!shouldShowLeftPanel && !panel.isCollapsed()) {
      panel.collapse();
    }
  }, [shouldShowLeftPanel, leftPanelRef]);

  // Sync right panel with store
  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;

    if (rightPanelOpen && panel.isCollapsed()) {
      panel.expand();
    } else if (!rightPanelOpen && !panel.isCollapsed()) {
      panel.collapse();
    }
  }, [rightPanelOpen, rightPanelRef]);

  // Drag-resize handlers

  function handleLeftResize(size: PanelSize) {
    if (!mountedRef.current) return;

    // Drag to 0 → hide the panel visually. URL stays put: the user
    // wanted more main-panel space, not to leave their work context.
    if (size.asPercentage === 0 && useSidebarStore.getState().leftPanelOpen) {
      setLeftPanelOpen(false);
      return;
    }
    // Drag away from 0 while currently collapsed → re-show the panel.
    // If the URL doesn't carry a section, navigate to the last visited
    // one so the freshly-expanded panel has something to render.
    if (size.asPercentage > 0 && !useSidebarStore.getState().leftPanelOpen) {
      setLeftPanelOpen(true);
      if (!activeLeftPanel) {
        router.push(lastPanelHrefRef.current);
      }
    }
  }

  function handleRightResize(size: PanelSize) {
    if (!mountedRef.current) return;

    if (size.asPercentage === 0 && useSidebarStore.getState().rightPanelOpen) {
      setRightPanelOpen(false);
    }
    if (size.asPercentage > 0 && !useSidebarStore.getState().rightPanelOpen) {
      setRightPanelOpen(true);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <ResizablePanelGroup orientation="horizontal">
        {/* ── Left: side panel (collapsible) ──────────────────────────── */}
        <ResizablePanel
          panelRef={leftPanelRef}
          defaultSize="0px"
          minSize={LEFT_MIN_PX}
          maxSize={LEFT_MAX_PX}
          collapsible
          collapsedSize={0}
          onResize={handleLeftResize}
        >
          <SidePanel />
        </ResizablePanel>

        <ResizableHandle />

        {/* ── Center: main workspace ─────────────────────────────────── */}
        <ResizablePanel minSize={CENTER_MIN_PX}>
          <main className="flex h-full flex-col overflow-hidden">
            {children}
          </main>
        </ResizablePanel>

        <ResizableHandle />

        {/* ── Right: Chat + History (collapsible) ────────────────────── */}
        <ResizablePanel
          panelRef={rightPanelRef}
          defaultSize={RIGHT_DEFAULT_PX}
          minSize={RIGHT_MIN_PX}
          collapsible
          collapsedSize={0}
          onResize={handleRightResize}
        >
          <RightPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
