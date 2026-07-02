/**
 * Evaluation — scoring thresholds and level definitions.
 *
 * Isomorphic (no "server-only") so both client UI and server-side
 * runner can import. The values here are CODE DEFAULTS; the
 * authoritative runtime values live in the `config` DB table
 * (keys `eval.threshold.*`) and are read by the server-side runner
 * via `getConfigNumber`. Client components use the code defaults
 * directly — they converge on the next page reload after an admin
 * updates the DB.
 *
 * See docs/evaluation.md.
 */

// ─── Thresholds ─────────────────────────────────────────────────────

/** Score >= this is "excellent". */
export const EVAL_THRESHOLD_EXCELLENT = 80;

/** Score >= this is "pass". */
export const EVAL_THRESHOLD_PASS = 60;

/** Score >= this is "poor"; below is "fail". */
export const EVAL_THRESHOLD_POOR = 40;

// ─── Level system ───────────────────────────────────────────────────

export type EvalLevel = "excellent" | "pass" | "poor" | "fail";

export interface EvalLevelMeta {
  label: string;
  color: string;      // text color class
  barColor: string;    // progress bar bg class
  bgColor: string;     // badge bg class
}

export const LEVEL_META: Record<EvalLevel, EvalLevelMeta> = {
  excellent: { label: "Excellent", color: "text-emerald-400", barColor: "bg-emerald-500", bgColor: "bg-emerald-500/15" },
  pass:      { label: "Pass",      color: "text-blue-400",    barColor: "bg-blue-500",    bgColor: "bg-blue-500/15" },
  poor:      { label: "Poor",      color: "text-amber-400",   barColor: "bg-amber-500",   bgColor: "bg-amber-500/15" },
  fail:      { label: "Fail",      color: "text-red-400",     barColor: "bg-red-500",     bgColor: "bg-red-500/15" },
};

/** Map a 0-100 score to an evaluation level. */
export function scoreToLevel(score: number): EvalLevel {
  if (score >= EVAL_THRESHOLD_EXCELLENT) return "excellent";
  if (score >= EVAL_THRESHOLD_PASS) return "pass";
  if (score >= EVAL_THRESHOLD_POOR) return "poor";
  return "fail";
}

/** Bar color class for a given score. */
export function barColorForScore(score: number): string {
  return LEVEL_META[scoreToLevel(score)].barColor;
}

// ─── Config keys (for server-side getConfigNumber) ──────────────────

export const CONFIG_KEY_EXCELLENT = "eval.threshold.excellent";
export const CONFIG_KEY_PASS      = "eval.threshold.pass";
export const CONFIG_KEY_POOR      = "eval.threshold.poor";
