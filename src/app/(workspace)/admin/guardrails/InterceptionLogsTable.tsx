"use client";

/**
 * InterceptionLogsTable — Full-width audit log stream table with inline expandable context rows.
 *
 * Displays security interception records from SafetyInterceptionLogTable.
 * Supports filtering by Stage, Category, Action, Severity, global search, and inline expandable context payload.
 */

import { Fragment, useState } from "react";
import { Search, Filter, RefreshCw, Clock, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface InterceptionLogItem {
  id: number;
  runId?: string | null;
  userId?: string | null;
  agentName?: string | null;
  userName?: string | null;
  stage: string;
  category: string;
  policyId?: number | null;
  policyName?: string | null;
  policyType?: string | null;
  toolName?: string | null;
  action: string;
  severity: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface InterceptionLogsTableProps {
  logs: InterceptionLogItem[];
  onRefresh?: () => void;
}

/**
 * Safely format a short preview string for the Context column from payload.
 */
function formatContextPreview(payload: Record<string, unknown>): string {
  if (typeof payload.snippet === "string" && payload.snippet.trim()) {
    return payload.snippet;
  }
  if (typeof payload.text === "string" && payload.text.trim()) {
    return payload.text;
  }
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  const keys = Object.keys(payload);
  if (keys.length === 0) return "—";
  return JSON.stringify(payload);
}

export function InterceptionLogsTable({ logs, onRefresh }: InterceptionLogsTableProps) {
  const [search, setSearch] = useState("");
  const [selectedStage, setSelectedStage] = useState<string>("all");
  const [selectedSeverity, setSelectedSeverity] = useState<string>("all");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const filteredLogs = logs.filter((log) => {
    if (selectedStage !== "all" && log.stage !== selectedStage) return false;
    if (selectedSeverity !== "all" && log.severity !== selectedSeverity) return false;
    if (search) {
      const q = search.toLowerCase();
      const matchName = log.policyName?.toLowerCase().includes(q);
      const matchTool = log.toolName?.toLowerCase().includes(q);
      const matchCat = log.category.toLowerCase().includes(q);
      const matchAgent = log.agentName?.toLowerCase().includes(q);
      const matchUser = log.userName?.toLowerCase().includes(q);
      const contextPreview = formatContextPreview(log.payload).toLowerCase();
      const matchContext = contextPreview.includes(q);
      if (!matchName && !matchTool && !matchCat && !matchAgent && !matchUser && !matchContext) return false;
    }
    return true;
  });

  return (
    <div className="flex h-full w-full flex-col rounded-xl border bg-card/60 p-4 shadow-sm backdrop-blur-sm">
      {/* Top Filter Bar */}
      <div className="flex items-center justify-between gap-3 pb-3 border-b">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Security Interception Audit Trail</h3>
          <Badge variant="secondary" className="text-[10px] h-4">
            {logs.length}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {/* Stage Filter */}
          <Select value={selectedStage} onValueChange={(val) => setSelectedStage(val ?? "all")}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <Filter className="h-3 w-3 mr-1 text-muted-foreground" />
              <SelectValue placeholder="All Stages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stages</SelectItem>
              <SelectItem value="input">Input</SelectItem>
              <SelectItem value="tool_call">Tool Call</SelectItem>
              <SelectItem value="tool_result">Tool Result</SelectItem>
              <SelectItem value="output">Output</SelectItem>
            </SelectContent>
          </Select>

          {/* Severity Filter */}
          <Select value={selectedSeverity} onValueChange={(val) => setSelectedSeverity(val ?? "all")}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <Filter className="h-3 w-3 mr-1 text-muted-foreground" />
              <SelectValue placeholder="All Severities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severities</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>

          {/* Global Search */}
          <div className="relative w-52">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search agent, topic & context..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>

          {onRefresh && (
            <Button variant="outline" size="sm" className="h-8 px-2 text-xs gap-1" onClick={onRefresh}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          )}
        </div>
      </div>

      {/* Main Expandable Log Table */}
      <div className="flex-1 overflow-auto rounded-lg border bg-background/50 mt-3">
        <Table>
          <TableHeader className="bg-muted/40 sticky top-0 z-10">
            <TableRow className="h-8">
              <TableHead className="w-8 py-1"></TableHead>
              <TableHead className="text-xs font-semibold py-1 w-36">Time</TableHead>
              <TableHead className="text-xs font-semibold py-1 w-32">Agent</TableHead>
              <TableHead className="text-xs font-semibold py-1 w-28">User</TableHead>
              <TableHead className="text-xs font-semibold py-1 w-24">Stage</TableHead>
              <TableHead className="text-xs font-semibold py-1 w-32">Category</TableHead>
              <TableHead className="text-xs font-semibold py-1 w-60">Policy / Tool</TableHead>
              <TableHead className="text-xs font-semibold py-1 w-20">Action</TableHead>
              <TableHead className="text-xs font-semibold py-1 w-20">Severity</TableHead>
              <TableHead className="text-xs font-semibold py-1 min-w-[200px]">Context</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredLogs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-xs text-muted-foreground py-12">
                  No security interception logs found
                </TableCell>
              </TableRow>
            ) : (
              filteredLogs.map((log) => {
                const isExpanded = expandedIds.has(log.id);
                const formattedAgentName =
                  log.agentName === "supervisor"
                    ? "Supervisor (Nango)"
                    : log.agentName || "N/A";
                const displayUserName = log.userName || log.userId || "N/A";
                const previewContext = formatContextPreview(log.payload);

                return (
                  <Fragment key={log.id}>
                    <TableRow
                      className={cn(
                        "h-9 cursor-pointer transition-colors hover:bg-muted/40",
                        isExpanded && "bg-muted/30 border-b-0",
                      )}
                      onClick={() => toggleExpand(log.id)}
                    >
                      <TableCell className="w-8 py-1 pr-0">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground py-1 whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="py-1">
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium bg-background/80 truncate max-w-[120px]">
                          {formattedAgentName}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs font-mono py-1 text-foreground truncate max-w-[100px]">
                        {displayUserName}
                      </TableCell>
                      <TableCell className="text-xs font-mono uppercase text-muted-foreground py-1">
                        {log.stage}
                      </TableCell>
                      <TableCell className="py-1">
                        <span className="text-xs font-medium text-foreground">{log.category}</span>
                      </TableCell>
                      <TableCell className="text-xs font-mono py-1 truncate max-w-[240px]">
                        {log.policyName || log.toolName || "N/A"}
                      </TableCell>
                      <TableCell className="text-xs font-medium capitalize py-1">
                        <span
                          className={cn(
                            log.action === "block"
                              ? "text-red-600 dark:text-red-400 font-semibold"
                              : log.action === "redact"
                              ? "text-blue-600 dark:text-blue-400"
                              : "text-amber-600 dark:text-amber-400",
                          )}
                        >
                          {log.action}
                        </span>
                      </TableCell>
                      <TableCell className="py-1">
                        <SeverityText severity={log.severity} />
                      </TableCell>
                      <TableCell className="py-1 min-w-0">
                        <span className="text-xs font-mono text-muted-foreground line-clamp-1 truncate">
                          {previewContext}
                        </span>
                      </TableCell>
                    </TableRow>

                    {/* Collapsible Expanded Snippet Sub-row */}
                    {isExpanded && (
                      <TableRow className="bg-muted/20 hover:bg-muted/20 border-t-0">
                        <TableCell colSpan={10} className="p-2.5 pl-10">
                          <div className="rounded-lg border bg-slate-950 p-3 shadow-xs">
                            <pre className="max-h-[300px] overflow-auto text-[11px] font-mono text-slate-100 whitespace-pre-wrap break-all leading-relaxed">
                              {typeof log.payload.snippet === "string" && log.payload.snippet
                                ? log.payload.snippet
                                : typeof log.payload.text === "string" && log.payload.text
                                ? log.payload.text
                                : JSON.stringify(log.payload, null, 2)}
                            </pre>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SeverityText({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    low: "text-emerald-600 dark:text-emerald-400",
    medium: "text-blue-600 dark:text-blue-400",
    high: "text-amber-600 dark:text-amber-400",
    critical: "text-red-600 dark:text-red-400 font-semibold",
  };
  return (
    <span className={cn("text-xs font-medium capitalize", styles[severity] ?? "text-muted-foreground")}>
      {severity}
    </span>
  );
}
