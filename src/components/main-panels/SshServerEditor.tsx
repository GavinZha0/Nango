"use client";

/**
 * SshServerEditor — full-area form for creating / editing one
 * See docs/ssh.md.,
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Plug,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCopilotDraft } from "@/hooks/useCopilotDraft";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DeleteConfirmDialog } from "@/components/ui/delete-confirm-dialog";
import { cn } from "@/lib/utils";

const NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
const FP_RE = /^SHA256:[A-Za-z0-9+/=]+$/;

// Types

export interface SshServerDetail {
  id: string;
  name: string;
  description: string | null;
  credentialId: string;
  host: string;
  port: number;
  knownHostFingerprint: string;
  commandAllow: string[] | null;
  commandApprove: string[];
  commandDeny: string[];
  loginShell: boolean;
  enabled: boolean;
  visibility: string;
}

interface CredentialOption {
  id: string;
  name: string;
}

export interface SshServerEditorProps {
  /** Existing id when editing; null when creating. */
  sshServerId: string | null;
  /** Existing row when editing — fetched by the page wrapper. */
  initialDetail?: SshServerDetail;
  onBack: () => void;
  onSaved: () => void;
}

// Allow/deny list helpers

function parseCommandList(raw: string): string[] {
  // One pattern per line — same convention as Dockerfile / .gitignore
  // / SSH allowlist literature. Empty / whitespace-only lines dropped.
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatCommandList(list: string[] | null): string {
  return list ? list.join("\n") : "";
}

// Form state

interface FormState {
  name: string;
  description: string;
  credentialId: string;
  host: string;
  port: string;
  fingerprint: string;
  commandAllowText: string;
  commandApproveText: string;
  commandDenyText: string;
  loginShell: boolean;
}

function buildInitialForm(detail: SshServerDetail | undefined): FormState {
  return {
    name: detail?.name ?? "",
    description: detail?.description ?? "",
    credentialId: detail?.credentialId ?? "",
    host: detail?.host ?? "",
    port: String(detail?.port ?? 22),
    fingerprint: detail?.knownHostFingerprint ?? "",
    commandAllowText: formatCommandList(detail?.commandAllow ?? null),
    commandApproveText: formatCommandList(detail?.commandApprove ?? []),
    commandDenyText: formatCommandList(detail?.commandDeny ?? []),
    loginShell: detail?.loginShell ?? true,
  };
}

// Component

export function SshServerEditor({
  sshServerId,
  initialDetail,
  onBack,
  onSaved,
}: SshServerEditorProps): ReactNode {
  const isNew = sshServerId === null;

  // Form state — single object for all editable fields.
  // `savedForm` is the snapshot taken at load time; comparing the two
  // gives us `isDirty` for the Save button.
  const [form, setForm] = useState<FormState>(() =>
    buildInitialForm(initialDetail),
  );
  const [savedForm] = useState<FormState>(() =>
    buildInitialForm(initialDetail),
  );
  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedForm),
    [form, savedForm],
  );
  const update = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  // Copilot draft integration
  const getCurrentData = useCallback(
    () => form as FormState & Record<string, unknown>,
    [form],
  );
  const applyDraft = useCallback((draft: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...draft }));
  }, []);
  const { draftApplied, clearDraftState } = useCopilotDraft({
    resourceType: "ssh-server",
    getCurrentData,
    applyDraft,
  });

  // Remote data (not part of the form)
  const [credentials, setCredentials] = useState<CredentialOption[]>([]);

  // Operation state
  const [saving, setSaving] = useState<boolean>(false);
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<boolean>(false);
  const [verifyResult, setVerifyResult] = useState<
    | { ok: true; durationMs: number }
    | { ok: false; code: string; message: string }
    | null
  >(null);
  /**
   * Inline-hint state for the fingerprint field. Two flavours:
   *   - "first": this is a New row and the user just got the
   *     fingerprint back from Verify. Prompt them to eyeball it.
   *   - "changed": this is an existing row and the freshly captured
   *     fingerprint differs from the saved pin (host re-key OR MITM).
   *     Show old/new side by side.
   * Cleared on successful Save.
   */
  const [fpHint, setFpHint] = useState<
    | { kind: "first" }
    | { kind: "changed"; previous: string }
    | null
  >(null);

  // Credentials list — only ssh-shaped credentials.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/ssh-credentials");
        if (!cancelled && res.ok) {
          const data = (await res.json()) as CredentialOption[];
          setCredentials(data);
        }
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const credentialOptions = useMemo(
    () =>
      [...credentials].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    [credentials],
  );

  // Validation

  /** Connection-level checks shared by Save and Verify. */
  function validateConnectionFields(): string | null {
    if (!form.credentialId) return "Credential is required.";
    if (!form.host.trim()) return "Host is required.";
    const portNum = Number(form.port);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      return "Port must be an integer between 1 and 65535.";
    }
    return null;
  }

  /** Full form validation for Save (name + connection + fingerprint). */
  function validateLocal(): string | null {
    if (!form.name.trim()) return "Name is required.";
    if (!NAME_RE.test(form.name)) {
      return "Name must start with a-z and contain only [a-z0-9_-] (max 63 chars).";
    }
    const connErr = validateConnectionFields();
    if (connErr) return connErr;
    // Fingerprint is OPTIONAL on submit.
    if (form.fingerprint.trim() && !FP_RE.test(form.fingerprint.trim())) {
      return (
        "Fingerprint must be SHA256:<base64>. Click Verify connection " +
        "to fill it in automatically, or leave it blank and Save."
      );
    }
    return null;
  }

  // Persist

  function buildPayload(forCreate: boolean): Record<string, unknown> {
    const allowParsed = parseCommandList(form.commandAllowText);
    const approveParsed = parseCommandList(form.commandApproveText);
    const denyParsed = parseCommandList(form.commandDenyText);
    const fp = form.fingerprint.trim();
    const base: Record<string, unknown> = {
      description: form.description.trim() || null,
      credentialId: form.credentialId,
      host: form.host.trim(),
      port: Number(form.port),
      // Omit the field entirely when blank.
      ...(fp ? { knownHostFingerprint: fp } : {}),
      commandAllow: allowParsed,
      commandApprove: approveParsed,
      commandDeny: denyParsed,
      loginShell: form.loginShell,
    };
    if (forCreate) {
      base.name = form.name;
    }
    return base;
  }

  async function handleSave(): Promise<void> {
    const localErr = validateLocal();
    if (localErr) {
      setError(localErr);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const url = isNew
        ? "/api/ssh-servers"
        : `/api/ssh-servers/${sshServerId}`;
      const method = isNew ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(isNew)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        setError(body?.message ?? body?.error ?? `HTTP ${res.status}`);
        return;
      }
      // Save succeeded — clear inline hints + draft state.
      setFpHint(null);
      setVerifyResult(null);
      clearDraftState();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm(): Promise<void> {
    if (!sshServerId) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/ssh-servers/${sshServerId}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        setError(body?.message ?? `HTTP ${res.status}`);
        return;
      }
      setDeleteOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Run "Verify connection" — the unified host-key-capture + auth
   * probe.
   *
   * Two endpoints back this:
   *   - existing row → POST /api/ssh-servers/[id]/verify-connection
   *     (server has the credential id). The response also carries
   *     `pinnedFingerprint` — what's currently in the DB — so the
   *     UI can decide between "first" and "changed" hints.
   *   - new row     → POST /api/ssh-servers/verify-connection
   *     (stateless; payload carries credentialId / host / port).
   *
   * Either way, on a success or AUTH_FAILED the server returns a
   * `fingerprint` string we drop into the input field. The hint
   * below the field is set per the rules in the `fpHint` doc above.
   */
  async function handleVerifyConnection(): Promise<void> {
    const connErr = validateConnectionFields();
    if (connErr) {
      setVerifyResult({ ok: false, code: "VALIDATION_FAILED", message: connErr });
      return;
    }
    const portNum = Number(form.port);

    setVerifying(true);
    setVerifyResult(null);
    try {
      // Always use the stateless endpoint with current form data so
      // unsaved edits are verified — not the DB-persisted version.
      const res = await fetch("/api/ssh-servers/verify-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: form.host.trim(),
          port: portNum,
          credentialId: form.credentialId,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            ok: boolean;
            durationMs: number;
            fingerprint: string | null;
            pinnedFingerprint?: string | null;
            error?: { code: string; message: string };
            // Standard ApiError envelope for 4xx / 5xx (e.g. credential
            // load failure inside the stateless verify endpoint).
            message?: string;
            code?: string;
          }
        | null;
      if (!res.ok) {
        setVerifyResult({
          ok: false,
          code: body?.code ?? "REQUEST_FAILED",
          message: body?.message ?? body?.error?.message
            ?? `HTTP ${res.status}`,
        });
        return;
      }

      // Success path OR auth-failed-with-fingerprint-captured path.
      const captured = body?.fingerprint ?? null;
      if (captured) {
        // Compute the inline hint BEFORE we overwrite `fingerprint` state.
        // Use the DB-saved fingerprint from mount time (initialDetail)
        // instead of the API response since we now always use the
        // stateless endpoint.
        const previous = sshServerId
          ? (initialDetail?.knownHostFingerprint ?? "")
          : "";
        if (previous && previous !== captured) {
          setFpHint({ kind: "changed", previous });
        } else if (!previous) {
          setFpHint({ kind: "first" });
        } else {
          setFpHint(null);
        }
        update("fingerprint", captured);
      }

      if (body?.ok) {
        setVerifyResult({ ok: true, durationMs: body.durationMs });
      } else {
        setVerifyResult({
          ok: false,
          code: body?.error?.code ?? "UNKNOWN",
          message: body?.error?.message ?? "Unknown error",
        });
      }
    } catch (err) {
      setVerifyResult({
        ok: false,
        code: "NETWORK",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setVerifying(false);
    }
  }

  // Render

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Back"
          className="h-7 w-7"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Plug className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">
          {isNew ? "New SSH server" : initialDetail?.name}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleVerifyConnection()}
            disabled={verifying || saving}
          >
            {verifying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">Verify connection</span>
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || (!isNew && !isDirty && !draftApplied)}
            className={cn("h-8 gap-1.5", draftApplied && "bg-amber-600 hover:bg-amber-700 text-white")}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
          {!isNew && (
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5 bg-primary text-destructive hover:bg-primary/80 hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={saving || deleting}
              title="Delete this SSH server (cannot be undone)"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete
            </Button>
          )}
        </div>
      </div>

      <DeleteConfirmDialog
        title="Delete SSH server"
        description={<>Permanently delete <strong>{initialDetail?.name ?? form.name}</strong>? Agents that bind this server will lose the binding (no further calls will dispatch). This cannot be undone.</>}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void handleDeleteConfirm()}
        deleting={deleting}
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {(error || verifyResult) && (
            <div className="space-y-2">
              {error && (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              {verifyResult && (
                <div
                  className={cn(
                    "flex items-center gap-2 rounded border px-3 py-2 text-xs",
                    verifyResult.ok
                      ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300"
                      : "border-destructive/40 bg-destructive/10 text-destructive",
                  )}
                >
                  {verifyResult.ok ? (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      <span>
                        Verified — host key captured and credential
                        authenticated ({verifyResult.durationMs} ms)
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4" />
                      <span>
                        <span className="font-mono">{verifyResult.code}</span>
                        {": "}
                        {verifyResult.message}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Identity ─────────────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Identity
            </h3>
            <div className="space-y-2">
              <Label htmlFor="ssh-name">Name</Label>
              <Input
                id="ssh-name"
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                disabled={!isNew}
                placeholder="Lowercase letters, digits, _ and -. Cannot be changed later"
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ssh-desc">Description</Label>
              <Textarea
                id="ssh-desc"
                value={form.description}
                onChange={(e) => update("description", e.target.value)}
                placeholder=""
                rows={2}
              />
            </div>
          </section>

          {/* ── Connection ──────────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Connection
            </h3>
            <div className="flex items-center gap-3">
              <Label htmlFor="ssh-host" className="w-20 shrink-0">
                Host
              </Label>
              <Input
                id="ssh-host"
                value={form.host}
                onChange={(e) => update("host", e.target.value)}
                placeholder="prod.example.com or 10.0.1.5"
                className="flex-1"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="ssh-port" className="w-20 shrink-0">
                Port
              </Label>
              <Input
                id="ssh-port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => update("port", e.target.value)}
                className="flex-1"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="ssh-credential" className="w-20 shrink-0">
                Credential
              </Label>
              <div className="flex-1">
                <Select
                  value={form.credentialId}
                  onValueChange={(v) => update("credentialId", v ?? "")}
                >
                  <SelectTrigger id="ssh-credential" className="w-full">
                    {/*
                     * Pass children to SelectValue so the trigger
                     * resolves the credential's NAME from our own
                     * lookup. Without this, Base UI's default
                     * fallback can render the raw uuid (e.g. when
                     * the credentials list arrives via fetch AFTER
                     * the initial render and no matching SelectItem
                     * is mounted yet). Same fix used in
                     * DataSourceEditor.
                     */}
                    <SelectValue placeholder="Select an SSH credential…">
                      {form.credentialId
                        ? (credentials.find((c) => c.id === form.credentialId)
                            ?.name ?? "Unknown credential")
                        : null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {credentialOptions.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No SSH credentials. Create one from the Credentials admin page.
                      </div>
                    ) : (
                      credentialOptions.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="ssh-fingerprint" className="w-20 shrink-0">
                Fingerprint
              </Label>
              <Input
                id="ssh-fingerprint"
                value={form.fingerprint}
                onChange={(e) => {
                  update("fingerprint", e.target.value);
                  // Manual edits invalidate any inline hint sourced
                  // from the last Verify — the user is now in
                  // control of what's about to be saved.
                  setFpHint(null);
                }}
                placeholder="Auto-filled by Verify connection"
                className="flex-1 font-mono"
              />
            </div>
            {/*
             * Inline red hints under the fingerprint row. No dialog,
             * no confirmation button — the user accepts whatever is
             * in the field by clicking Save (per the agreed-upon UX
             * for an internal-trusted-network deployment).
             */}
            {fpHint?.kind === "first" && (
              <p className="pl-[5.75rem] text-xs text-red-600 dark:text-red-400">
                First connection — please verify this fingerprint matches the host.
              </p>
            )}
            {fpHint?.kind === "changed" && (
              <p className="pl-[5.75rem] text-xs text-red-600 dark:text-red-400">
                Host key changed since this server was saved.
                <br />
                <span className="font-mono">Was: {fpHint.previous}</span>
                <br />
                <span className="font-mono">Now: {form.fingerprint}</span>
                <br />
                Confirm with the host operator that a legitimate re-key
                happened, then click Save to update the pin.
              </p>
            )}
            <div className="flex items-center gap-3">
              <Label htmlFor="ssh-login-shell" className="w-20 shrink-0">
                Login shell
              </Label>
              <div className="flex flex-1 items-center gap-2">
                <Switch
                  id="ssh-login-shell"
                  checked={form.loginShell}
                  onCheckedChange={(v) => update("loginShell", v)}
                />
                <span className="text-xs text-muted-foreground">
                  Wrap commands in <code className="font-mono">bash -lc &apos;...&apos;</code>
                </span>
              </div>
            </div>
          </section>

          {/* ── Policy ──────────────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Command policy
            </h3>
            <p className="text-xs text-muted-foreground">
              Enforced by the runtime before opening the SSH channel:
              denied commands fail with{" "}
              <code className="font-mono">error: &quot;POLICY_DENIED&quot;</code>{" "}
              and never reach the host. <strong>Empty allowlist</strong>{" "}
              means no constraint (any command allowed);{" "}
              <strong>any pattern</strong> in the allowlist switches the
              host to allow-only mode. Denylist always wins on a match.
              Patterns are JavaScript regexes — anchor with <code>^</code>{" "}
              for prefix matches.
            </p>
            <div className="space-y-2">
              <Label htmlFor="ssh-allow">Allowlist</Label>
              <Textarea
                id="ssh-allow"
                value={form.commandAllowText}
                onChange={(e) => update("commandAllowText", e.target.value)}
                placeholder={"^ls\n^cat\n^tail\n// One regex per line. Anchor with ^ for prefix matches."}
                rows={5}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ssh-approve">
                Require Approval List (Auto Mode)
              </Label>
              <Textarea
                id="ssh-approve"
                value={form.commandApproveText}
                onChange={(e) => update("commandApproveText", e.target.value)}
                placeholder={"^rm\n^drop"}
                rows={3}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ssh-deny">
                Denylist
              </Label>
              <Textarea
                id="ssh-deny"
                value={form.commandDenyText}
                onChange={(e) => update("commandDenyText", e.target.value)}
                placeholder={"rm\nshutdown\nreboot"}
                rows={3}
                className="font-mono text-xs"
              />
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
