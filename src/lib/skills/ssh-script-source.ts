/**
 * Shared byte-level gate for scripts declared in `scripts-on-ssh`.
 *
 * These files are not executed locally: their source is embedded in a command
 * string and handed to `bash -c` / `python3 -c` on a remote host. Anything the
 * encoder mangles in transit executes as mojibake there, far from the skill
 * author. Every boundary that can see the bytes — folder
 * import and dispatch — calls {@link readSshScriptSource} so the check has
 * one definition.
 *
 * See docs/skills.md and docs/ssh.md.
 */

export type SshScriptRejectReason = "NOT_UTF8" | "NUL_BYTES";

export type SshScriptSource =
  | { ok: true; text: string }
  | { ok: false; reason: SshScriptRejectReason };

/**
 * Decode script bytes or say why they cannot be shipped.
 *
 * CONTRACT: `Buffer.toString("utf-8")` never throws — it maps ill-formed
 * sequences to U+FFFD. Only a fatal {@link TextDecoder} makes "not UTF-8"
 * observable, which is the whole point of this check.
 *
 * QUIRK: a leading UTF-8 BOM is stripped rather than rejected. `bash` treats
 * it as part of the first token and `python3 -c` reports a syntax error, so a
 * BOM-authored script is otherwise unrunnable and stripping is the only repair
 * available at dispatch time.
 */
export function readSshScriptSource(bytes: Uint8Array): SshScriptSource {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "NOT_UTF8" };
  }
  if (text.includes("\0")) {
    return { ok: false, reason: "NUL_BYTES" };
  }
  return { ok: true, text };
}

/** Generic strict UTF-8/NUL gate for any text script (SSH or SQL). */
export const readTextScriptSource = readSshScriptSource;

/** Author-facing remediation for a rejected script. */
export function describeUnusableSshScript(
  scriptPath: string,
  reason: SshScriptRejectReason,
): string {
  return reason === "NOT_UTF8"
    ? `${scriptPath} is not valid UTF-8. Re-save it as UTF-8 before declaring it in scripts-on-ssh.`
    : `${scriptPath} contains NUL bytes, so it is not a text script and cannot run via scripts-on-ssh.`;
}
