"use client";

/**
 * SaveAsCaseDialog — invoked from the MCP test page after a successful
 * tool invocation. Captures (serverId, toolName, input) as a new
 * verification case under either an existing MCP suite or a new one
 * created inline. Initial `assertions` is empty (smoke-test case —
 * see `@/components/main-panels/verification/NewCaseDialog.tsx` for
 * the same convention).
 *
 * Suite list is filtered to `category='mcp'` server-side via
 * `/api/verification-suites?category=mcp`.
 *
 * Direct `fetch` is used (instead of `verificationActions.create` /
 * `caseActions.create`) so 409 / 400 messages can be surfaced INLINE
 * in the dialog; the store actions swallow errors into a panel-wide
 * `error` field which would be invisible here. Stores are still
 * updated on success (`upsert` + `bumpCaseCount`) so the
 * VerificationPanel badge stays consistent without a re-fetch.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useVerificationStore,
  type VerificationSuiteRow,
} from "@/store/verification";
import {
  useCasesStore,
  type VerificationCaseRow,
} from "@/store/verification-cases";

// --- Constants --------------------------------------------------------------

/** Sentinel value for the "create new suite" Select item. Chosen so it
 *  can never collide with a real UUID suite id. */
const NEW_SUITE_SENTINEL = "__new__";

// --- Helpers ----------------------------------------------------------------

interface ErrorEnvelope {
  message?: string;
  code?: string;
}

async function readApiError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as ErrorEnvelope | null;
  return body?.message ?? `${res.status} ${res.statusText}`;
}

async function fetchMcpSuites(): Promise<VerificationSuiteRow[]> {
  const res = await fetch("/api/verification-suites?category=mcp");
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as VerificationSuiteRow[];
}

async function createMcpSuite(name: string): Promise<VerificationSuiteRow> {
  const res = await fetch("/api/verification-suites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      category: "mcp",
      visibility: "private",
    }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as VerificationSuiteRow;
}

async function createMcpCase(
  suiteId: string,
  body: {
    name: string;
    mcpServerId: string;
    toolName: string;
    input: Record<string, unknown>;
  },
): Promise<VerificationCaseRow> {
  const res = await fetch(`/api/verification-suites/${suiteId}/cases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, assertions: [] }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as VerificationCaseRow;
}

// --- Props ------------------------------------------------------------------

export interface SaveAsCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** UUID of the MCP server whose tool was just executed. */
  mcpServerId: string;
  /** Display name of the server, shown read-only in the dialog. */
  serverName: string;
  /** Tool name (string identifier on the server). */
  toolName: string;
  /** Args passed to the just-completed tool call. Saved verbatim as
   *  `verification_case.input`. */
  input: Record<string, unknown>;
}

// --- Component --------------------------------------------------------------

export function SaveAsCaseDialog({
  open,
  onOpenChange,
  mcpServerId,
  serverName,
  toolName,
  input,
}: SaveAsCaseDialogProps): ReactNode {
  const [suites, setSuites] = useState<VerificationSuiteRow[]>([]);
  const [loadingSuites, setLoadingSuites] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");
  const [newSuiteName, setNewSuiteName] = useState<string>("");
  const [caseName, setCaseName] = useState<string>("");

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset form whenever the dialog opens. Uses the "render-time prop
  // change" pattern (mirrors NewCaseDialog) to avoid useEffect churn.
  const [lastOpen, setLastOpen] = useState<boolean>(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setSelectedSuiteId("");
      setNewSuiteName("");
      setCaseName(toolName);
      setSubmitError(null);
    }
  }

  // Fetch suite list on open. Cancellable for rapid open/close.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingSuites(true);
    setLoadError(null);
    fetchMcpSuites()
      .then((rows) => {
        if (cancelled) return;
        setSuites(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingSuites(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const creatingNewSuite: boolean = selectedSuiteId === NEW_SUITE_SENTINEL;
  const trimmedCaseName: string = caseName.trim();
  const trimmedNewSuiteName: string = newSuiteName.trim();

  const canSubmit: boolean =
    !submitting &&
    trimmedCaseName.length > 0 &&
    (creatingNewSuite
      ? trimmedNewSuiteName.length > 0
      : selectedSuiteId !== "");

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // 1) Resolve suiteId — create the suite first if needed.
      let suiteId: string;
      let createdSuite: VerificationSuiteRow | null = null;
      if (creatingNewSuite) {
        createdSuite = await createMcpSuite(trimmedNewSuiteName);
        suiteId = createdSuite.id;
      } else {
        suiteId = selectedSuiteId;
      }

      // 2) Create the case under the resolved suite.
      const caseRow: VerificationCaseRow = await createMcpCase(suiteId, {
        name: trimmedCaseName,
        mcpServerId,
        toolName,
        input,
      });

      // 3) Update the client stores so the panels stay in sync without
      //    a re-fetch. Done AFTER both creates succeed — partial state
      //    on the suite-level if the case create fails is acceptable
      //    (the suite is real on the server; we just upsert it too so
      //    the user sees it on next visit to the verification panel).
      if (createdSuite) {
        useVerificationStore.getState().upsert({ ...createdSuite, caseCount: 0 });
      }
      useCasesStore.getState().upsert(caseRow);
      useVerificationStore.getState().bumpCaseCount(suiteId, +1);

      toast.success("Saved verification case", {
        description: createdSuite
          ? `Created suite "${createdSuite.name}" with 1 case.`
          : `Added "${caseRow.name}" to the suite.`,
      });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as verification case</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Server (read-only) */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label className="text-muted-foreground">Server</Label>
            <span className="truncate text-sm font-mono">{serverName}</span>
          </div>

          {/* Tool (read-only) */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label className="text-muted-foreground">Tool</Label>
            <span className="truncate text-sm font-mono">{toolName}</span>
          </div>

          {/* Suite picker */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label htmlFor="save-case-suite">
              Suite <span className="text-destructive">*</span>
            </Label>
            <Select
              value={selectedSuiteId}
              onValueChange={(v) => setSelectedSuiteId(v ?? "")}
              disabled={loadingSuites}
            >
              <SelectTrigger id="save-case-suite" className="w-full">
                <SelectValue
                  placeholder={
                    loadingSuites ? "Loading suites…" : "Pick a suite"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {suites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
                {suites.length > 0 && (
                  <div className="my-1 h-px bg-border" aria-hidden />
                )}
                <SelectItem value={NEW_SUITE_SENTINEL}>
                  + New suite…
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* New-suite name (only when creating) */}
          {creatingNewSuite && (
            <div className="grid grid-cols-[80px_1fr] items-center gap-2">
              <Label htmlFor="save-case-new-suite">
                New name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="save-case-new-suite"
                value={newSuiteName}
                onChange={(e) => setNewSuiteName(e.target.value)}
                placeholder="e.g. GitHub MCP smoke tests"
                autoFocus
              />
            </div>
          )}

          {/* Case name */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label htmlFor="save-case-name">
              Case name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="save-case-name"
              value={caseName}
              onChange={(e) => setCaseName(e.target.value)}
              placeholder="e.g. search returns at least one hit"
              autoFocus={!creatingNewSuite}
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Captures the input you just ran. Edit assertions later in the
            suite editor.
          </p>

          {(loadError || submitError) && (
            <p className="text-xs text-destructive">
              {submitError ?? loadError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
