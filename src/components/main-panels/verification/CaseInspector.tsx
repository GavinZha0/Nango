"use client";

/**
 * CaseInspector — middle + right column of the verification suite
 * editor, merged into one component so panes share the case's local
 * draft state without cross-component prop drilling.
 *
 * Editor column (left) is a vertical split:
 *   - Input (JSON object) on top, ~40% height.
 *   - Assertions (JSON array) below, fills the rest.
 * Both share `useJsonDraft`: debounced PATCH on change, flush on blur,
 * flush again right before Run case so the runner reads the user's
 * latest edits from DB. Free-form textareas — no per-type assertion
 * form — match the data shape and what LLMs produce.
 *
 * Right column: Run case button + outcome viewer (status, duration,
 * assertion verdicts, payload, error envelope).
 *
 * Rename + Delete are handled at the suite-editor level (`CaseTree`
 * row icons → RenameCaseDialog / DeleteCaseDialog) so this component
 * stays focused on input + assertions + run.
 *
 * History-view mode (parent passes `historyMeta`) tints the outcome
 * toolbar amber, prefixes the row with `#N` + `(startedAt)`, and
 * freezes the input/assertion textareas. Run case stays available;
 * clicking it calls `onExitHistoryView` then reruns with the case's
 * current DB definition.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { caseActions, type VerificationCaseRow } from "@/store/verification-cases";
import type {
  AssertionResult,
  AssertionSpec,
  CaseExecutionOutcome,
  ErrorEnvelope,
} from "@/lib/verification/types";

// --- Props ------------------------------------------------------------------

export interface CaseInspectorProps {
  caseRow: VerificationCaseRow;
  /**
   * Outcome supplied by the parent — the persisted suite-run result
   * for this case from a run snapshot (just-completed live run OR an
   * explicit history-view chip selection). Falls back to the local
   * single-case rerun outcome when present, so an in-place "Run
   * case" click still overrides the pinned suite snapshot until the
   * user navigates away.
   */
  pinnedOutcome?: CaseExecutionOutcome;
  /**
   * Non-null when the parent has put the editor into history-view
   * mode (a banner chip is selected). Drives the amber `#N …` prefix
   * + amber tint on the outcome toolbar row — replaces the prior
   * standalone notice bar. `startedAt` is the run's start time
   * (Date or ISO string — the Drizzle row exposes a Date, but JSON
   * transit downgrades it to a string; both formats are accepted).
   */
  historyMeta?: {
    seq: number;
    startedAt: Date | string;
    /** Frozen input as it was sent at run time — sourced from the
     *  matching `verification_case_result.input_snapshot` row.
     *  `null` when the case wasn't part of the selected run. */
    inputSnapshot: unknown;
  } | null;
  /** Called when the user clicks Run case in history-view mode — the
   *  parent uses this to drop `selectedRunId/Seq` so the editor
   *  returns to live view as the rerun fires. No-op outside history
   *  mode (we always invoke; the parent should make it idempotent). */
  onExitHistoryView?: () => void;
}

// --- useJsonDraft hook ------------------------------------------------------

const DEBOUNCE_MS: number = 400;

interface JsonDraftOptions<T> {
  /** Initial parsed value — captured once on mount. */
  initial: T;
  /** Validate the JSON.parse result. Return `{ok:true, value}` or `{ok:false, error}`. */
  validate: (parsed: unknown) => { ok: true; value: T } | { ok: false; error: string };
  /** Persist a validated value. Promise resolves after PATCH settles. */
  commit: (value: T) => Promise<unknown>;
}

interface JsonDraft {
  text: string;
  setText: (next: string) => void;
  /** Commit immediately (used on blur). */
  flushNow: () => void;
  /** Commit + await; returns true on valid + persisted. Used before Run case. */
  flushAwait: () => Promise<boolean>;
  parseError: string | null;
  saving: boolean;
}

/**
 * Debounced JSON textarea state. Shared by the Input and Assertions
 * panes so they behave identically.
 *
 * NOTE: `key={caseRow.id}` on the parent ensures this hook remounts
 * per case selection, so `initial` doesn't need a re-seed pathway.
 */
/** Same canonical seeding the textarea uses on mount — extracted so
 *  the `lastCommittedRef` baseline below stays in lock-step without
 *  reading the state value during render (which the project's React
 *  19 lint rejects). */
function seedTextFor(initial: unknown): string {
  if (Array.isArray(initial) && initial.length === 0) return "";
  if (
    initial !== null &&
    typeof initial === "object" &&
    Object.keys(initial as object).length === 0
  ) {
    return "";
  }
  return JSON.stringify(initial, null, 2);
}

function useJsonDraft<T>(opts: JsonDraftOptions<T>): JsonDraft {
  const { initial, validate, commit } = opts;
  // Empty array / object → start with truly empty text so the
  // placeholder overlay (rendered by `JsonPane`) is fully visible.
  // The validator below treats empty text as "no overrides" and
  // hands a canonical empty value to `commit`, so persisted state
  // stays consistent (`[]` / `{}`).
  const [text, setTextState] = useState<string>(() => seedTextFor(initial));
  const [parseError, setParseError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last raw text that was successfully committed to the server.
  // Seeded to the same value as `text` so the very first blur on an
  // unchanged pane is a no-op. Without this guard, every focus-out
  // (and every debounce flush of unchanged content) fires a PATCH —
  // tabbing between Input and Assertions used to storm the API.
  const lastCommittedRef = useRef<string>(seedTextFor(initial));

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // `commit` and `validate` are NOT held in refs — `setText` /
  // `flushNow` / `flushAwait` are recreated each render, so any
  // setTimeout scheduled by them already captures the latest closure.
  // Holding them in refs would mutate ref.current during render, which
  // React 19's strict-mode lint rejects.

  const doCommit = (
    raw: string,
    commitNow: JsonDraftOptions<T>["commit"],
    validateNow: JsonDraftOptions<T>["validate"],
  ): boolean => {
    // No-op if the raw text hasn't changed since the last successful
    // commit. Cheap string compare — covers the common case of
    // focus-out without edits AND the debounce-flush of an unchanged
    // value. (Whitespace-only edits still PATCH; acceptable.)
    if (raw === lastCommittedRef.current) {
      setParseError(null);
      return true;
    }
    // Empty text is intentional — means "no overrides". Hand `null`
    // to the validator as a sentinel so each pane can substitute its
    // canonical empty value (`[]` for Assertions, `{}` for Input).
    let parsed: unknown;
    if (raw.trim() === "") {
      parsed = null;
    } else {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (err) {
        setParseError(err instanceof Error ? err.message : String(err));
        return false;
      }
    }
    const verdict = validateNow(parsed);
    if (!verdict.ok) {
      setParseError(verdict.error);
      return false;
    }
    setParseError(null);
    setSaving(true);
    lastCommittedRef.current = raw;
    void commitNow(verdict.value).finally(() => setSaving(false));
    return true;
  };

  const setText = (next: string): void => {
    setTextState(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => doCommit(next, commit, validate),
      DEBOUNCE_MS,
    );
  };

  const flushNow = (): void => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    doCommit(text, commit, validate);
  };

  const flushAwait = async (): Promise<boolean> => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // Short-circuit if nothing changed since the last successful
    // commit — matches `doCommit`'s identical guard so "Run case"
    // doesn't issue a redundant PATCH before the run POST.
    if (text === lastCommittedRef.current) {
      setParseError(null);
      return true;
    }
    // Same empty-text shortcut as `doCommit`. Keep both branches in
    // sync — `flushAwait` is called by the "Run case" button.
    let parsed: unknown;
    if (text.trim() === "") {
      parsed = null;
    } else {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (err) {
        setParseError(err instanceof Error ? err.message : String(err));
        return false;
      }
    }
    const verdict = validate(parsed);
    if (!verdict.ok) {
      setParseError(verdict.error);
      return false;
    }
    setParseError(null);
    setSaving(true);
    try {
      await commit(verdict.value);
      lastCommittedRef.current = text;
      return true;
    } finally {
      setSaving(false);
    }
  };

  return { text, setText, flushNow, flushAwait, parseError, saving };
}

// --- Constants -------------------------------------------------------------

/**
 * Shown as ghost-text in the Assertions pane while the textarea is
 * empty. Demonstrates the three assertion kinds together so new users
 * have a copy-paste starting point. The leading `// example:` line
 * makes its hint-nature obvious if the user does paste the body.
 * Pure UI hint — never persisted, never parsed by the runner.
 */
const ASSERTIONS_PLACEHOLDER: string = `// example:
${JSON.stringify(
  [
    { type: "js_expression", expression: "result.total > 0" },
    {
      type: "json_schema",
      schema: {
        type: "object",
        required: ["items"],
        properties: { items: { type: "array", minItems: 1 } },
      },
    },
    { type: "jsonpath_equals", path: "items[0].key", expected: 12345 },
  ],
  null,
  2,
)}`;

// --- Validators (module-scoped so hook deps stay stable) -------------------

function validateInputObject(
  parsed: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  // `null` is the empty-text sentinel from `useJsonDraft` —
  // canonicalize to `{}` so persisted state is consistent.
  if (parsed === null) return { ok: true, value: {} };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Input must be a JSON object." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function validateAssertionsArray(
  parsed: unknown,
): { ok: true; value: AssertionSpec[] } | { ok: false; error: string } {
  // `null` is the empty-text sentinel from `useJsonDraft` —
  // canonicalize to `[]` (smoke test) so persisted state is consistent.
  if (parsed === null) return { ok: true, value: [] };
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "Assertions must be a JSON array." };
  }
  // Shallow structural check — the server re-validates with Zod
  // (`wire-schemas.ts`) and rejects with a precise message anyway.
  // We just catch the obvious shape mistakes here so the user gets
  // immediate feedback in the editor.
  //
  // `type` is OPTIONAL on the wire (server infers from `schema` /
  // `path` / `expression`); we mirror that here so the editor doesn't
  // block a payload the backend would happily accept. When `type` IS
  // present we still verify it's one of the known literals.
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `Item #${i + 1} must be an object.` };
    }
    const obj = item as Record<string, unknown>;
    const type = obj.type;
    if (type !== undefined) {
      if (
        type !== "json_schema" &&
        type !== "jsonpath_equals" &&
        type !== "js_expression"
      ) {
        return {
          ok: false,
          error: `Item #${i + 1}: type must be one of json_schema, jsonpath_equals, js_expression.`,
        };
      }
    } else if (
      !("schema" in obj) &&
      !("path" in obj) &&
      !("expression" in obj)
    ) {
      return {
        ok: false,
        error: `Item #${i + 1}: needs either a "type" or one of "schema" / "path" / "expression".`,
      };
    }
  }
  return { ok: true, value: parsed as AssertionSpec[] };
}

// --- Component --------------------------------------------------------------

export function CaseInspector({
  caseRow,
  pinnedOutcome,
  historyMeta = null,
  onExitHistoryView,
}: CaseInspectorProps): ReactNode {
  // Input pane — JSON object.
  const inputDraft = useJsonDraft<Record<string, unknown>>({
    initial: caseRow.input ?? {},
    validate: validateInputObject,
    commit: (value) => caseActions.patch(caseRow, { input: value }),
  });

  // Assertions pane — JSON array of AssertionSpec.
  const assertionsDraft = useJsonDraft<AssertionSpec[]>({
    initial: caseRow.assertions ?? [],
    validate: validateAssertionsArray,
    commit: (value) => caseActions.patch(caseRow, { assertions: value }),
  });

  // Run state
  const [running, setRunning] = useState<boolean>(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<CaseExecutionOutcome | null>(
    null,
  );

  // --- Run plumbing ---------------------------------------------------------

  const handleRunCase = async (): Promise<void> => {
    // Leaving history view first: if the user was inspecting an old
    // run, the act of rerunning the case is an explicit "focus on
    // fresh execution" — drop the snapshot pin so the new outcome
    // (which arrives via `lastOutcome`) isn't shadowed.
    onExitHistoryView?.();
    setRunError(null);
    setLastOutcome(null);
    setRunning(true);
    try {
      // Flush both panes BEFORE issuing the run — the runner reads
      // input + assertions from DB, not from the draft.
      const [inputOk, assertionsOk] = await Promise.all([
        inputDraft.flushAwait(),
        assertionsDraft.flushAwait(),
      ]);
      if (!inputOk || !assertionsOk) {
        setRunError("Fix the JSON errors above before running.");
        return;
      }
      const res = await fetch(`/api/verification-cases/${caseRow.id}/run`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
      }
      setLastOutcome((await res.json()) as CaseExecutionOutcome);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  // --- Render ---------------------------------------------------------------

  // Priority: a fresh single-case rerun (`lastOutcome`) wins over
  // the suite-run snapshot (`pinnedOutcome`) — the user just clicked
  // "Run case" and expects to see THAT result, not the stale
  // suite-run row. CaseInspector remounts (via `key={case.id}` on
  // the parent) when the user switches cases, so `lastOutcome`
  // never bleeds across cases.
  const displayedOutcome = lastOutcome ?? pinnedOutcome ?? null;

  // History-view styling. Active ONLY when the parent supplied meta
  // AND we're showing the snapshot (not a fresh single-case rerun).
  const showHistoryChrome: boolean =
    historyMeta !== null && lastOutcome === null;
  const historyStartedAtLabel: string | null = showHistoryChrome
    ? new Date(historyMeta!.startedAt).toLocaleString()
    : null;
  // Input + assertion textareas freeze in history view so the user
  // can't accidentally mutate the live case definition while reading
  // an old run. Run case is intentionally NOT gated by this — it
  // clears the history pin (via `onExitHistoryView`) and reruns with
  // whatever input the case currently has in the DB.
  const readOnly: boolean = showHistoryChrome;

  // History-mode pane overrides:
  //   - Input  → the frozen `inputSnapshot` from the selected run
  //              (the live `caseRow.input` may have been edited since).
  //   - Assertions → the DB never snapshots the spec, only the
  //              evaluated `assertion_results`. We swap the body for
  //              an explanatory notice and point users at Verdicts.
  const inputOverrideText: string | null = showHistoryChrome
    ? JSON.stringify(historyMeta!.inputSnapshot ?? {}, null, 2)
    : null;
  const assertionsHistoryNotice: string | null = showHistoryChrome
    ? "// Assertion specs are not snapshotted per run.\n// The evaluated verdicts for this run appear in the Verdicts panel →"
    : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top toolbar spans both columns so the four panes below share
          a single vertical baseline — OUTPUT lines up with INPUT and
          VERDICTS lines up with ASSERTIONS. */}
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-2",
          // History tint — amber background + bottom border so the row
          // itself acts as the "you're viewing run #N" indicator,
          // replacing the previous standalone notice bar.
          showHistoryChrome &&
            "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        )}
      >
        {showHistoryChrome && (
          <span
            className="text-xs font-semibold"
            title={`Viewing snapshot of run #${historyMeta!.seq} — started ${historyStartedAtLabel}`}
          >
            #{historyMeta!.seq}
          </span>
        )}
        {displayedOutcome && (
          <>
            <span
              className={cn(
                "text-xs font-semibold",
                // In history-view the row already carries amber. Keep
                // the status word readable but defer color to the row
                // tint so the whole line reads as one history badge.
                showHistoryChrome
                  ? "text-amber-700 dark:text-amber-300"
                  : outcomeStatusColor(displayedOutcome.status),
              )}
            >
              {displayedOutcome.status.toUpperCase()}
            </span>
            <span
              className={cn(
                "text-[11px]",
                showHistoryChrome
                  ? "text-amber-700/80 dark:text-amber-300/80"
                  : "text-muted-foreground",
              )}
            >
              {displayedOutcome.durationMs} ms
              {historyStartedAtLabel && (
                <span className="ml-1">({historyStartedAtLabel})</span>
              )}
            </span>
          </>
        )}
        <Button
          size="sm"
          // h-6 + text-xs to baseline-match the Run suite button on the
          // sibling CaseTree header — they share the same `py-2` outer
          // padding, so equal inner heights guarantee aligned bottom
          // borders across the two columns.
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => void handleRunCase()}
          disabled={running || !caseRow.enabled}
          title={
            !caseRow.enabled
              ? "Enable the case to run it."
              : showHistoryChrome
                ? "Run this case now — exits history view."
                : "Run this case once. Result is shown below — nothing is persisted."
          }
        >
          {running ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Play className="mr-1 h-3 w-3" />
          )}
          Run case
        </Button>
      </div>

      {/* Transport / orchestration error from `handleRunCase`. The
          outcome-level error envelope is rendered separately inside
          VERDICTS so it sits next to the assertion verdicts it
          invalidated. */}
      {runError && (
        <p className="border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {runError}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1fr_1fr]">
        {/* --- Left column: Input (top, 2fr) + Assertions (bottom, 3fr) --- */}
        <div className="grid min-h-0 grid-rows-[2fr_3fr] overflow-hidden lg:border-r">
          <JsonPane
            label="Input"
            hint=""
            draft={inputDraft}
            readOnly={readOnly}
            ariaLabel="Case input JSON"
            overrideText={inputOverrideText}
          />
          <JsonPane
            label="Assertions"
            hint=""
            draft={assertionsDraft}
            readOnly={readOnly}
            ariaLabel="Case assertions JSON"
            placeholder={ASSERTIONS_PLACEHOLDER}
            overrideText={assertionsHistoryNotice}
            // Mirror the `(N)` count Verdicts shows on the right.
            // We use the committed `caseRow.assertions` rather than
            // parsing the live draft so an in-flight invalid edit
            // doesn't flicker the badge. Suppressed in history view
            // (the override notice owns the body).
            count={
              showHistoryChrome ? null : (caseRow.assertions?.length ?? 0)
            }
          />
        </div>

        {/* --- Right column: Output (top, 2fr) ↔ Input,
                              Verdicts (bot, 3fr) ↔ Assertions --- */}
        <div className="grid min-h-0 grid-rows-[2fr_3fr] overflow-hidden">
          <OutputPane
            outcome={displayedOutcome}
            running={running}
            readOnly={readOnly}
          />
          <VerdictsPane
            outcome={displayedOutcome}
            running={running}
            readOnly={readOnly}
          />
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---------------------------------------------------------

interface JsonPaneProps {
  label: string;
  hint: string;
  draft: JsonDraft;
  readOnly: boolean;
  ariaLabel: string;
  /** Ghost-text placeholder rendered over the textarea when the
   *  draft is empty. `useJsonDraft` normalises an empty array / object
   *  initial value to an empty string, so a fresh case shows the
   *  placeholder cleanly with nothing underneath. Click-through
   *  (`pointer-events-none`) — typing hides it because the real
   *  characters paint over it. */
  placeholder?: string;
  /** When non-null, the textarea displays this text verbatim instead
   *  of `draft.text` and edits are dropped — used by history-view to
   *  render the per-run `input_snapshot` (Input pane) or a "spec not
   *  recoverable" notice (Assertions pane). The pane is implicitly
   *  read-only in this mode; callers should also pass `readOnly`. */
  overrideText?: string | null;
  /** Optional item-count badge rendered next to the label, e.g.
   *  `Assertions (3)` to mirror the Verdicts pane. `null` hides it. */
  count?: number | null;
}

function JsonPane({
  label,
  hint,
  draft,
  readOnly,
  ariaLabel,
  placeholder,
  overrideText = null,
  count = null,
}: JsonPaneProps): ReactNode {
  // Override wins when present — it carries history-view content
  // (input snapshot OR an explanatory notice) that must never be
  // mutated through the draft. Placeholder is suppressed in this
  // mode since the textarea is no longer "empty".
  const displayText: string = overrideText ?? draft.text;
  const showPlaceholder: boolean =
    overrideText === null && !!placeholder && draft.text.trim() === "";
  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {count !== null && (
          <span className="text-[10px] text-muted-foreground">({count})</span>
        )}
        {draft.saving && (
          <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 pb-2">
        {/* Relative wrapper hosts the ghost-text overlay. */}
        <div className="relative min-h-0 flex-1">
          <textarea
            value={displayText}
            onChange={(e) => {
              // Drop edits when an override is active — the visible
              // text isn't the draft's; mutating draft.text would
              // both desync the display and corrupt the live case.
              if (overrideText !== null) return;
              draft.setText(e.target.value);
            }}
            onBlur={overrideText !== null ? undefined : draft.flushNow}
            disabled={readOnly}
            spellCheck={false}
            className={cn(
              "h-full w-full resize-none rounded-md border bg-background p-2 font-mono text-xs leading-relaxed",
              draft.parseError && overrideText === null && "border-destructive",
            )}
            aria-label={ariaLabel}
          />
          {showPlaceholder && (
            <pre
              aria-hidden
              className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre rounded-md p-2 font-mono text-xs leading-relaxed text-muted-foreground/40"
            >
              {placeholder}
            </pre>
          )}
        </div>
        {draft.parseError && overrideText === null && (
          <p className="text-[11px] text-destructive">{draft.parseError}</p>
        )}
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

// --- Outcome viewer ---------------------------------------------------------

/** Tailwind colour class for the status pill shown in the Run header. */
function outcomeStatusColor(status: CaseExecutionOutcome["status"]): string {
  switch (status) {
    case "passed":
      return "text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "text-red-600 dark:text-red-400";
    case "errored":
    case "timeout":
      return "text-amber-600 dark:text-amber-400";
    case "skipped":
      return "text-muted-foreground";
  }
}

interface OutputPaneProps {
  outcome: CaseExecutionOutcome | null;
  running: boolean;
  readOnly: boolean;
}

/**
 * OUTPUT pane — top half of the right column, mirrors INPUT on the
 * left. Renders the raw tool response (the MCP `CallToolResult`
 * envelope) once a run has produced one. Before that, shows an
 * in-frame placeholder so the box itself never disappears.
 */
function OutputPane({ outcome, running, readOnly }: OutputPaneProps): ReactNode {
  const truncated: boolean = outcome?.resultTruncated ?? false;
  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Output
        </span>
        {truncated && (
          <span className="text-[10px] text-muted-foreground">(truncated)</span>
        )}
      </div>
      <div className="min-h-0 flex-1 px-3 pb-2">
        {outcome && outcome.resultPayload !== null ? (
          <pre className="h-full w-full overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
            {JSON.stringify(outcome.resultPayload, null, 2)}
          </pre>
        ) : (
          <div className="grid h-full place-items-center rounded-md border border-dashed text-[11px] text-muted-foreground">
            {placeholderText({ outcome, running, readOnly, kind: "output" })}
          </div>
        )}
      </div>
    </div>
  );
}

interface VerdictsPaneProps {
  outcome: CaseExecutionOutcome | null;
  running: boolean;
  readOnly: boolean;
}

/**
 * VERDICTS pane — bottom half of the right column, mirrors ASSERTIONS
 * on the left. Each row is the evaluated result of the corresponding
 * assertion definition. When the case errored before any assertion
 * could run, the verdict list is empty and the error envelope carries
 * the explanation instead.
 */
function VerdictsPane({
  outcome,
  running,
  readOnly,
}: VerdictsPaneProps): ReactNode {
  const verdicts: readonly AssertionResult[] = outcome?.assertionResults ?? [];
  const error: ErrorEnvelope | null = outcome?.error ?? null;
  const hasContent: boolean = verdicts.length > 0 || !!error;
  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Verdicts
        </span>
        {verdicts.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            ({verdicts.length})
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 px-3 pb-2">
        {hasContent ? (
          <div className="h-full space-y-2 overflow-auto rounded-md border bg-muted/30 p-2">
            {error && <ErrorView err={error} />}
            {verdicts.length > 0 && (
              <ul className="space-y-1">
                {verdicts.map((r, i) => (
                  <AssertionVerdictRow key={i} verdict={r} />
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="grid h-full place-items-center rounded-md border border-dashed text-[11px] text-muted-foreground">
            {placeholderText({ outcome, running, readOnly, kind: "verdicts" })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Centralised text for the OUTPUT / VERDICTS empty-state frames. */
function placeholderText({
  outcome,
  running,
  readOnly,
  kind,
}: {
  outcome: CaseExecutionOutcome | null;
  running: boolean;
  readOnly: boolean;
  kind: "output" | "verdicts";
}): string {
  if (running) return "Running…";
  if (!outcome) {
    return readOnly
      ? "No persisted result for this case in this run."
      : "Click Run case to see the result.";
  }
  // Outcome present but the pane has nothing to show.
  return kind === "output"
    ? "No payload returned."
    : "No assertions — smoke test (passes iff the tool returned without error).";
}

function ErrorView({ err }: { err: ErrorEnvelope }): ReactNode {
  return (
    <div className="rounded border border-destructive/40 bg-destructive/10 p-2">
      <p className="font-medium text-destructive">
        [{err.source}] {err.message}
      </p>
      {err.details && (
        <pre className="mt-1 overflow-x-auto text-[10px] text-destructive/80">
          {JSON.stringify(err.details, null, 2)}
        </pre>
      )}
    </div>
  );
}

function AssertionVerdictRow({
  verdict,
}: {
  verdict: AssertionResult;
}): ReactNode {
  return (
    <li className="flex items-start gap-2 rounded border border-border/60 bg-background/40 px-2 py-1 font-mono text-[11px]">
      <span
        className={cn(
          "shrink-0",
          verdict.ok
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-red-600 dark:text-red-400",
        )}
      >
        {verdict.ok ? "✓" : "✗"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">
          #{verdict.index + 1} · {verdict.type}
        </p>
        {verdict.message && (
          <p className="break-words text-[10px]">{verdict.message}</p>
        )}
      </div>
    </li>
  );
}
