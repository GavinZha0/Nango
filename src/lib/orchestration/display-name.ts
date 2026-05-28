/**
 * Stable agent display-name algorithm shared by server and client.
 */

export type AgentSource = "backend" | "builtin";

export interface SourceLabelInput {
  source: AgentSource;
  /** Backend agents: credential's display name (used as the source label). */
  credentialName?: string;
  /** True for public agents created by another user. Appends `(public)` suffix to avoid name collision. */
  isPublicByOthers?: boolean;
}

export type DisplayNameInput = SourceLabelInput & { name: string };

const DISPLAY_NAME_SEPARATOR = " / ";

/** Source label used as the display-name prefix and as a catalog column. */
export function computeSourceLabel(input: SourceLabelInput): string {
  if (input.source === "backend") {
    return input.credentialName?.trim() || "Backend";
  }
  return input.isPublicByOthers ? "Built-in (public)" : "Built-in";
}

/**
 * Supervisor-facing identity: `${sourceLabel} / ${name}`.
 * CONTRACT: unique across user's visible catalog when `isPublicByOthers` is set.
 */
export function computeDisplayName(input: DisplayNameInput): string {
  return `${computeSourceLabel(input)}${DISPLAY_NAME_SEPARATOR}${input.name}`;
}

export const DISPLAY_NAME_SEP = DISPLAY_NAME_SEPARATOR;
