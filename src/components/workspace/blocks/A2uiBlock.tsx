"use client";

/**
 * A2uiBlockRenderer — renders an `A2uiBlock` inside Outcomes or saved
 * Artifact detail views using CopilotKit's native `standardUI` and
 * `SurfaceView` (backed by `recharts` for `Chart` components).
 *
 * Supplies a local `GenerativeUIRuntimeContext` backed by an isolated
 * `GenerativeUISurfaceManager`, so surfaces render reliably even when
 * outside `CopilotKitProvider` (e.g. `/artifacts/[id]` or when the active
 * agent has `generativeUiEnabled = false`) with zero coupling to ECharts.
 */

import { useMemo, type ReactElement } from "react";
import { useTheme } from "next-themes";
import {
  createGenerativeUIDispatcher,
  GenerativeUISurfaceManager,
} from "@copilotkit/core/generative-ui";
import {
  createGenerativeUI,
  standardUI,
} from "@copilotkit/react-core/v2/generative-ui";
import {
  GenerativeUIRuntimeContext,
  SurfaceView,
} from "@copilotkit/react-core/v2/generative-ui/native";
import {
  DARK_THEME,
  GenerativeUIError,
  STANDARD_CATALOG_ID,
} from "@copilotkit/shared/generative-ui";
import type { A2uiBlock } from "@/store/outcome-store";

interface Props {
  block: A2uiBlock;
  size?: "compact" | "large";
}

function resolveCatalogForSurface(catalogId: string) {
  if (!catalogId || catalogId === STANDARD_CATALOG_ID) {
    return standardUI;
  }
  return createGenerativeUI({
    id: catalogId,
    extends: [standardUI],
    components: {},
  });
}

export function A2uiBlockRenderer({ block, size = "compact" }: Props): ReactElement {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? DARK_THEME : undefined;

  const { runtime, surface } = useMemo(() => {
    const ui = resolveCatalogForSurface(block.surface.catalogId);
    const manager = new GenerativeUISurfaceManager(ui);
    manager.ingest("outcome", undefined, block.surface);
    const managed =
      manager.getSurface("outcome", block.surface.surfaceId) ??
      manager.getFailedSurface("outcome", block.surface.surfaceId);
    const dispatcher = createGenerativeUIDispatcher({
      getDeclared: () => ui.functions,
    });
    const rt: React.ContextType<typeof GenerativeUIRuntimeContext> = {
      manager,
      dispatcher,
      ui,
      transport: "tool",
      config: { ui },
      theme,
      forwardEvent: async () => ({
        ok: false,
        error: new GenerativeUIError(
          "handler_failed",
          "Outcomes and saved artifacts are read-only.",
        ),
      }),
      reportError: (info) => {
        console.warn("[A2uiBlockRenderer]", info);
      },
    };
    return { runtime: rt, surface: managed };
  }, [block.surface, theme]);

  if (!surface || surface.failed) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        Unable to render A2UI surface ({block.surface.surfaceId}).
      </div>
    );
  }

  const rejectedCount =
    block.surface.rejected.length + surface.clientRejected.length;
  const heightClass = size === "large" ? "max-h-[720px]" : "max-h-[420px]";

  return (
    <div className={`${heightClass} w-full flex flex-col overflow-y-auto space-y-2`}>
      {rejectedCount > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          {rejectedCount} UI update(s) could not be rendered
          {block.surface.rejected[0]?.reason
            ? `: ${block.surface.rejected[0].reason}`
            : "."}
        </div>
      ) : null}
      <GenerativeUIRuntimeContext.Provider value={runtime}>
        <SurfaceView surface={surface} />
      </GenerativeUIRuntimeContext.Provider>
    </div>
  );
}
