"use client";

/**
 * McpServerInfoDialog — Displays MCP server information including
 * protocol version, server metadata, capabilities, and instructions.
 */

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface McpServerInfo {
  name: string;
  serverName: string | null;
  serverVersion: string | null;
  serverInstructions: string | null;
  protocolEra: string | null;
  protocolVersion: string | null;
  serverCapabilities: Record<string, unknown> | null;
  tools: Array<{ name: string }> | null;
  prompts: Array<{ name: string }> | null;
  resources: Array<{ uri: string }> | null;
}

export function McpServerInfoDialog({
  server,
  onClose,
}: {
  server: McpServerInfo;
  onClose: () => void;
}): ReactNode {
  const caps = server.serverCapabilities ?? {};
  const toolCount = server.tools?.length ?? 0;
  const promptCount = server.prompts?.length ?? 0;
  const resourceCount = server.resources?.length ?? 0;

  // Format capability sub-items with check/cross indicators
  const renderSubItems = (name: string, cap: Record<string, unknown> | undefined): ReactNode => {
    if (!cap || typeof cap !== "object") return null;

    // For extensions, show each extension name with a checkmark
    if (name === "extensions") {
      const extKeys = Object.keys(cap);
      if (extKeys.length === 0) return null;
      return (
        <div className="flex items-center gap-2">
          {extKeys.map((k) => (
            <span key={k} className="flex items-center gap-0.5 text-[10px]">
              <span className="text-muted-foreground">{k.replace(/^io\.modelcontextprotocol\//, "")}</span>
              <span className="text-emerald-600 dark:text-emerald-400">✓</span>
            </span>
          ))}
        </div>
      );
    }

    // For tools/prompts/resources, show listChanged (and subscribe for resources)
    const subItems: ReactNode[] = [];
    if ("listChanged" in cap) {
      subItems.push(
        <span key="listChanged" className="flex items-center gap-0.5 text-[10px]">
          <span className="text-muted-foreground">listChanged</span>
          <span className={cap.listChanged ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}>
            {cap.listChanged ? "✓" : "✗"}
          </span>
        </span>
      );
    }
    if ("subscribe" in cap) {
      subItems.push(
        <span key="subscribe" className="flex items-center gap-0.5 text-[10px]">
          <span className="text-muted-foreground">subscribe</span>
          <span className={cap.subscribe ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}>
            {cap.subscribe ? "✓" : "✗"}
          </span>
        </span>
      );
    }

    if (subItems.length === 0) return null;
    return <div className="flex items-center gap-2">{subItems}</div>;
  };

  // Get sorted capability names from server response
  const capabilityNames = Object.keys(caps).sort();

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{server.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Server info block */}
          <div className="rounded-lg border bg-muted/30 divide-y">
            {/* Protocol */}
            <div className="grid grid-cols-[120px_1fr] items-center px-3 py-1.5 text-sm">
              <span className="text-xs text-muted-foreground">MCP Protocol</span>
              <span className="text-xs font-medium">
                {server.protocolVersion
                  ? `${server.protocolEra === "modern" ? "V2" : "V1"} (${server.protocolVersion})`
                  : server.protocolEra === "modern"
                    ? "V2 (2026-07-28)"
                    : server.protocolEra === "legacy"
                      ? "V1 (2025)"
                      : "Unknown"}
              </span>
            </div>
            {/* Server name */}
            <div className="grid grid-cols-[120px_1fr] items-center px-3 py-1.5 text-sm">
              <span className="text-xs text-muted-foreground">Server Name</span>
              <span className="text-xs font-medium truncate" title={server.serverName ?? undefined}>
                {server.serverName ?? "—"}
              </span>
            </div>
            {/* Server version */}
            <div className="grid grid-cols-[120px_1fr] items-center px-3 py-1.5 text-sm">
              <span className="text-xs text-muted-foreground">Server Version</span>
              <span className="text-xs font-medium">
                {server.serverVersion ?? "—"}
              </span>
            </div>
          </div>

          {/* Resource counts - single line */}
          <div className="flex items-center justify-center gap-4 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold">{toolCount}</span>
              <span className="text-xs text-muted-foreground">Tools</span>
            </div>
            <span className="text-muted-foreground/40">·</span>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold">{promptCount}</span>
              <span className="text-xs text-muted-foreground">Prompts</span>
            </div>
            <span className="text-muted-foreground/40">·</span>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold">{resourceCount}</span>
              <span className="text-xs text-muted-foreground">Resources</span>
            </div>
          </div>

          {/* Capability matrix - server reported only */}
          <div className="space-y-1.5">
            <h4 className="text-sm font-medium">Server Capabilities</h4>
            <div className="rounded-lg border divide-y">
              {capabilityNames.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  No capabilities reported
                </div>
              ) : (
                capabilityNames.map((name) => {
                  const cap = caps[name] as Record<string, unknown> | undefined;
                  const subItems = renderSubItems(name, cap);
                  return (
                    <div key={name} className="flex items-center px-3 py-1.5 text-sm">
                      <span className={cn(
                        "text-xs capitalize w-[90px] shrink-0",
                        subItems && "font-medium"
                      )}>{name}</span>
                      {subItems && (
                        <>
                          <div className="h-3 w-px bg-border mx-2" />
                          {subItems}
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Server Instructions */}
          {server.serverInstructions && (
            <div className="space-y-1.5">
              <h4 className="text-sm font-medium">Server Instructions</h4>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 overflow-y-auto max-h-[4.5em]">
                  {server.serverInstructions}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
