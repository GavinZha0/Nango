"use client";

/**
 * InterceptionLogsTable — Full-width audit log stream table for tab=logs.
 *
 * Displays security interception records from SafetyInterceptionLogTable.
 * Supports filtering by Stage, Category, Action, Severity, global search, and JSON Payload drawer.
 */

import { useState } from "react";
import { Search, Eye, Filter, RefreshCw, Clock, Terminal } from "lucide-react";
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface InterceptionLogItem {
  id: number;
  runId?: string | null;
  userId?: string | null;
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

export function InterceptionLogsTable({ logs, onRefresh }: InterceptionLogsTableProps) {
  const [search, setSearch] = useState("");
  const [selectedStage, setSelectedStage] = useState<string>("all");
  const [selectedSeverity, setSelectedSeverity] = useState<string>("all");
  const [activeLog, setActiveLog] = useState<InterceptionLogItem | null>(null);

  const filteredLogs = logs.filter((log) => {
    if (selectedStage !== "all" && log.stage !== selectedStage) return false;
    if (selectedSeverity !== "all" && log.severity !== selectedSeverity) return false;
    if (search) {
      const q = search.toLowerCase();
      const matchName = log.policyName?.toLowerCase().includes(q);
      const matchTool = log.toolName?.toLowerCase().includes(q);
      const matchCat = log.category.toLowerCase().includes(q);
      if (!matchName && !matchTool && !matchCat) return false;
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
            {logs.length} Total Logs
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
              <SelectItem value="input">input (Input Stage)</SelectItem>
              <SelectItem value="tool_call">tool_call (Tool Call)</SelectItem>
              <SelectItem value="tool_result">tool_result (Tool Result)</SelectItem>
              <SelectItem value="output">output (Output Stage)</SelectItem>
            </SelectContent>
          </Select>

          {/* Severity Filter */}
          <Select value={selectedSeverity} onValueChange={(val) => setSelectedSeverity(val ?? "all")}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue placeholder="All Severities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severities</SelectItem>
              <SelectItem value="low">low</SelectItem>
              <SelectItem value="medium">medium</SelectItem>
              <SelectItem value="high">high</SelectItem>
              <SelectItem value="critical">critical</SelectItem>
            </SelectContent>
          </Select>

          {/* Global Search */}
          <div className="relative w-52">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search policy/tool/category..."
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

      {/* Main Log Table */}
      <div className="flex-1 overflow-auto rounded-lg border bg-background/50 mt-3">
        <Table>
          <TableHeader className="bg-muted/40 sticky top-0">
            <TableRow className="h-8">
              <TableHead className="text-xs font-semibold py-1">Time</TableHead>
              <TableHead className="text-xs font-semibold py-1">Stage</TableHead>
              <TableHead className="text-xs font-semibold py-1">Category</TableHead>
              <TableHead className="text-xs font-semibold py-1">Trigger / Tool</TableHead>
              <TableHead className="text-xs font-semibold py-1">Action</TableHead>
              <TableHead className="text-xs font-semibold py-1">Severity</TableHead>
              <TableHead className="text-xs font-semibold text-right py-1">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredLogs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-12">
                  No security interception logs found
                </TableCell>
              </TableRow>
            ) : (
              filteredLogs.map((log) => (
                <TableRow key={log.id} className="h-9 hover:bg-muted/30">
                  <TableCell className="text-xs font-mono text-muted-foreground py-1">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="py-1">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono uppercase">
                      {log.stage}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-1">
                    <span className="text-xs font-medium text-foreground">{log.category}</span>
                  </TableCell>
                  <TableCell className="text-xs font-mono py-1">
                    {log.policyName || log.toolName || "N/A"}
                  </TableCell>
                  <TableCell className="py-1">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] px-1.5 py-0 capitalize font-medium",
                        log.action === "block"
                          ? "border-red-500/30 text-red-600 dark:text-red-400 bg-red-500/10"
                          : log.action === "redact"
                          ? "border-blue-500/30 text-blue-600 dark:text-blue-400"
                          : "border-amber-500/30 text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {log.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-1">
                    <SeverityBadge severity={log.severity} />
                  </TableCell>
                  <TableCell className="text-right py-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs gap-1"
                      onClick={() => setActiveLog(log)}
                    >
                      <Eye className="h-3 w-3" /> View
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* JSON Payload Detail Drawer */}
      <Sheet open={!!activeLog} onOpenChange={(open) => !open && setActiveLog(null)}>
        <SheetContent side="right" className="w-[480px] sm:w-[540px]">
          {activeLog && (
            <div className="flex flex-col gap-5 pt-4">
              <SheetHeader>
                <div className="flex items-center gap-2">
                  <Terminal className="h-5 w-5 text-primary" />
                  <SheetTitle className="text-base font-mono">
                    Interception Log #{activeLog.id}
                  </SheetTitle>
                </div>
                <SheetDescription className="text-xs text-muted-foreground">
                  Time: {new Date(activeLog.createdAt).toLocaleString()} | Run ID: {activeLog.runId || "N/A"}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-3 rounded-lg border bg-muted/30 p-3.5 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-muted-foreground">Stage:</span>
                    <p className="font-semibold uppercase text-foreground">{activeLog.stage}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Category:</span>
                    <p className="font-semibold text-foreground">{activeLog.category}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t">
                  <div>
                    <span className="text-muted-foreground">Action:</span>
                    <p className="font-semibold capitalize text-foreground">{activeLog.action}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Severity:</span>
                    <p className="font-semibold capitalize text-foreground">{activeLog.severity}</p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Interception Context Payload (JSON)
                </h4>
                <pre className="max-h-[360px] overflow-auto rounded-lg border bg-slate-950 p-3 text-[11px] font-mono text-slate-100">
                  {JSON.stringify(activeLog.payload, null, 2)}
                </pre>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button variant="outline" size="sm" onClick={() => setActiveLog(null)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    low: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    medium: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    high: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    critical: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20 font-bold animate-pulse",
  };
  return (
    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 capitalize", styles[severity] ?? "")}>
      {severity}
    </Badge>
  );
}
