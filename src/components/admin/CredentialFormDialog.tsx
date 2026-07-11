"use client";

import { useEffect, useMemo, useState, type ReactNode, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import { cn } from "@/lib/utils";
import type { CredentialType } from "@/lib/db/schema";
import {
  PROVIDERS,
  PROVIDER_MAP,
  getProviderService,
  SERVICE_LABELS,
  type ProviderEntry,
} from "@/lib/constants/providers";
import type { CredentialServiceType } from "@/lib/db/schema";
import { readApiError } from "@/lib/http/error-envelope";

// Types

export interface CredentialRow {
  id: string;
  name: string;
  type: string;
  serviceType: string;
  provider: string | null;
  restUrl: string | null;
  aguiUrl: string | null;
  metadata: { keyPreview?: string; expiresAt?: string } | null;
  enabled: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
  /** Number of builtin agents referencing this credential. */
  usageCount: number;
}

interface CredentialFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** When provided, the dialog is in edit mode. */
  editing?: CredentialRow;
}

// Payload field definitions per type

interface PayloadField {
  key: string;
  label: string;
  placeholder?: string;
  /** "textarea" renders a multi-line input (PEM keys, certs, …). */
  type?: "text" | "password" | "url" | "textarea";
}

const PAYLOAD_FIELDS: Record<CredentialType, PayloadField[]> = {
  api_key: [
    { key: "key", label: "API Key", placeholder: "sk-…", type: "password" },
  ],
  bearer_token: [
    { key: "token", label: "Bearer Token", placeholder: "eyJ…", type: "password" },
  ],
  basic_auth: [
    { key: "username", label: "Username" },
    { key: "password", label: "Password", type: "password" },
  ],
  oauth_client: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client Secret", type: "password" },
    { key: "tokenUrl", label: "Token URL", placeholder: "https://…/oauth/token", type: "url" },
  ],
  // Two-key authentication. Both fields are encrypted.
  keypair: [
    { key: "publicKey", label: "Public Key", placeholder: "pk-…", type: "password" },
    { key: "secretKey", label: "Secret Key", placeholder: "sk-…", type: "password" },
  ],
  // SSH key auth. Username travels alongside the secret. Passphrase is optional.
  private_key: [
    { key: "username", label: "Username" },
    {
      key: "privateKey",
      label: "Private Key (OpenSSH PEM)",
      placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n…",
      type: "textarea",
    },
    { key: "passphrase", label: "Passphrase", type: "password", placeholder: "Optional" },
  ],
};

const CREDENTIAL_TYPES: { value: CredentialType; label: string }[] = [
  { value: "api_key", label: "API Key" },
  { value: "bearer_token", label: "Bearer Token" },
  { value: "basic_auth", label: "Basic Auth (username + password)" },
  { value: "oauth_client", label: "OAuth Client" },
  { value: "keypair", label: "Key Pair (public + secret)" },
  { value: "private_key", label: "Private Key (SSH)" },
];

// Component

const INITIAL_PAYLOAD: Record<string, string> = {};

interface FormState {
  name: string;
  type: CredentialType;
  provider: string;
  restUrl: string;
  aguiUrl: string;
  payload: Record<string, string>;
  error: string;
}

function initialFormState(editing?: CredentialRow): FormState {
  return {
    name: editing?.name ?? "",
    type: (editing?.type as CredentialType) ?? "api_key",
    provider: editing?.provider ?? "",
    restUrl: editing?.restUrl ?? "",
    aguiUrl: editing?.aguiUrl ?? "",
    payload: INITIAL_PAYLOAD,
    error: "",
  };
}

export function CredentialFormDialog({
  open,
  onOpenChange,
  onSuccess,
  editing,
}: CredentialFormDialogProps): ReactNode {
  const isEdit = Boolean(editing);

  const [form, setForm] = useState<FormState>(() => initialFormState(editing));
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever the dialog opens or the editing target changes
  useEffect(() => {
    function reset() {
      setForm(initialFormState(editing));
    }
    reset();
  }, [editing, open]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setPayloadField(key: string, value: string) {
    setForm((f) => ({ ...f, payload: { ...f.payload, [key]: value } }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setField("error", "");

    if (!form.provider) {
      setField("error", "Please select a provider.");
      return;
    }

    // In edit mode, payload is optional (only re-encrypt if user filled anything)
    const fields = PAYLOAD_FIELDS[form.type];
    const hasPayloadInput = fields.some((f) => form.payload[f.key]?.trim());

    if (!isEdit && !hasPayloadInput) {
      setField("error", "Please fill in the credential fields.");
      return;
    }

    // Derive serviceType from provider; fall back to "other" for unknown providers
    const serviceType = getProviderService(form.provider) ?? "other";

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        serviceType,
        provider: form.provider,
        restUrl: form.restUrl.trim() || null,
        // Only persist AG-UI URL for agent-platform providers.
        aguiUrl:
          serviceType === "agent" ? form.aguiUrl.trim() || null : null,
      };
      if (!isEdit) body.type = form.type;
      if (hasPayloadInput) {
        const builtPayload: Record<string, string> = {};
        for (const f of fields) {
          if (form.payload[f.key]?.trim()) builtPayload[f.key] = form.payload[f.key].trim();
        }
        body.payload = builtPayload;
      }

      const url = isEdit
        ? `/api/admin/credentials/${editing!.id}`
        : "/api/admin/credentials";
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Standard envelope expands `details.issues`.
        setField("error", await readApiError(res));
        return;
      }

      onOpenChange(false);
      onSuccess();
    } catch {
      setField("error", "Unexpected error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const fields = PAYLOAD_FIELDS[form.type];
  // SSH servers hide URL inputs.
  const isSsh = form.provider === "ssh";
  // AG-UI URL is only meaningful for `agent` providers.
  const isAgent = getProviderService(form.provider) === "agent";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Credential" : "New Credential"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3 py-2">
          {/* Name */}
          <div className="grid grid-cols-[80px_1fr] items-center gap-2">
            <Label htmlFor="cred-name">Name <span className="text-destructive">*</span></Label>
            <Input
              id="cred-name"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
              placeholder="e.g. OpenAI Production"
            />
          </div>

          {/* Provider — 2-col searchable grid, auto-fills serviceType */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Provider <span className="text-destructive">*</span></Label>
              {form.provider && (
                <span className="text-xs text-muted-foreground">
                  {PROVIDERS.find((p) => p.value === form.provider)?.label}
                  <span className="mx-1">·</span>
                  {SERVICE_LABELS[
                    (getProviderService(form.provider) ?? "other") as CredentialServiceType
                  ]}
                </span>
              )}
            </div>
            <ProviderPicker
              value={form.provider}
              onChange={(v) => setField("provider", v)}
            />
          </div>

          {/* Endpoint URLs — the Base URL row is always shown so admins
              can keep a reference URL on every credential (informational
              for SSH; the actual host/port/fingerprint live on the
              ssh_server row created via /ssh-server/[id]).
              The AG-UI URL is meaningful only for `agent` providers
              (agno / Mastra / Dify) and stays hidden otherwise so
              the form for plain LLM / search / observability /
              datasource credentials reads as a single URL row.

              Inline label+input rows: `w-32` (128 px) is the smallest
              column that fits "Base URL or Host" without wrapping at
              text-sm; "AG-UI URL" sits comfortably inside the same
              column for visual alignment. */}
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center gap-3">
              <Label htmlFor="cred-rest-url" className="w-32 shrink-0">
                Base URL or Host
              </Label>
              <Input
                id="cred-rest-url"
                // Plain `text` (not `url`) so SSH admins can enter
                // bare hostnames like `prod.example.com` without
                // tripping HTML5 URL validation. Backend stores as text.
                type="text"
                value={form.restUrl}
                onChange={(e) => setField("restUrl", e.target.value)}
                // Placeholder hierarchy:
                //  1. SSH → bespoke hint (URL field is informational
                //     only; host/port live on the ssh_server row).
                //  2. Provider declares a public default URL
                //     (search providers do — see providers.ts) →
                //     show that URL so admins know they can leave
                //     the field empty.
                //  3. Generic fallback for providers with no
                //     well-known default (self-hosted agent
                //     platforms, MCP, …).
                placeholder={
                  isSsh
                    ? "Optional reference (e.g. prod.example.com) — not used at runtime"
                    : (PROVIDER_MAP.get(form.provider)?.defaultRestUrl ??
                        "http://localhost:7878")
                }
                className="flex-1"
              />
            </div>
            {isAgent && (
              <div className="flex items-center gap-3">
                <Label htmlFor="cred-agui-url" className="w-32 shrink-0">
                  AG-UI URL
                </Label>
                <Input
                  id="cred-agui-url"
                  type="url"
                  value={form.aguiUrl}
                  onChange={(e) => setField("aguiUrl", e.target.value)}
                  placeholder="http://localhost:7878/agui/{agentId}/agui"
                  className="flex-1"
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Label className="w-[140px] shrink-0">Credential Type</Label>
            {!isEdit ? (
              // Select's root isn't a flex child; the wrapper keeps it
              // from collapsing to content width.
              <div className="flex-1">
                <Select
                  value={form.type}
                  items={CREDENTIAL_TYPES.map((ct) => ({ value: ct.value, label: ct.label }))}
                  onValueChange={(v) => setForm((f) => ({ ...f, type: v as CredentialType, payload: INITIAL_PAYLOAD }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CREDENTIAL_TYPES.map((ct) => (
                      <SelectItem key={ct.value} value={ct.value}>
                        {ct.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <Input
                value={CREDENTIAL_TYPES.find((ct) => ct.value === form.type)?.label ?? form.type}
                disabled
                className="flex-1"
              />
            )}
          </div>

          {/* Secret Fields — driven by PAYLOAD_FIELDS[form.type]. */}
          <div className="space-y-3 rounded-md border p-3">
            {isSsh && (
              <p className="text-xs text-muted-foreground">
                The host, port, and pinned fingerprint live on the SSH server row —
                create one from the SSH Hosts panel after saving the credential.
              </p>
            )}
            {fields.map((f) => {
              const isSecret = f.type === "password" || f.type === "textarea";
              const placeholder = isEdit && isSecret
                ? "••••••••  (saved, leave blank to keep)"
                : f.placeholder;
              if (f.type === "textarea") {
                return (
                  <div key={f.key} className="space-y-1.5">
                    <Label htmlFor={`cred-${f.key}`}>{f.label}</Label>
                    <textarea
                      id={`cred-${f.key}`}
                      className={cn("w-full min-h-[120px] rounded-md border bg-background px-3 py-2 text-sm font-mono", isEdit && isSecret && "placeholder:text-yellow-400")}
                      value={form.payload[f.key] ?? ""}
                      onChange={(e) => setPayloadField(f.key, e.target.value)}
                      placeholder={placeholder}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                );
              }
              return (
                <div key={f.key} className="flex items-center gap-3">
                  <Label
                    htmlFor={`cred-${f.key}`}
                    className="w-32 shrink-0"
                  >
                    {f.label}
                  </Label>
                  <Input
                    id={`cred-${f.key}`}
                    type={f.type ?? "text"}
                    value={form.payload[f.key] ?? ""}
                    onChange={(e) => setPayloadField(f.key, e.target.value)}
                    placeholder={placeholder}
                    autoComplete="off"
                    className={cn("flex-1", isEdit && isSecret && "placeholder:text-yellow-400")}
                  />
                </div>
              );
            })}
          </div>

          {form.error && (
            <p className="whitespace-pre-line text-sm text-destructive">{form.error}</p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (isEdit ? "Saving…" : "Creating…") : (isEdit ? "Save Changes" : "Create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ProviderPicker

interface ProviderPickerProps {
  value: string;
  onChange: (value: string) => void;
}

/** Deterministic Tailwind color class set for the letter avatar. */
const AVATAR_PALETTE: string[] = [
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-lime-500/15 text-lime-600 dark:text-lime-400",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
  "bg-pink-500/15 text-pink-600 dark:text-pink-400",
];

/** djb2-style hash → palette index. Stable across renders. */
function avatarColorClass(slug: string): string {
  let h: number = 5381;
  for (let i = 0; i < slug.length; i++) {
    h = ((h << 5) + h + slug.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/** Initials shown in the letter avatar (max 2 chars). */
function providerInitials(p: ProviderEntry): string {
  const words: string[] = p.label.replace(/[()]/g, "").split(/\s+/).filter(Boolean);
  const head: string = words[0] ?? p.value;
  if (words.length >= 2) return (head[0] + words[1][0]).toUpperCase();
  return head.slice(0, 2).toUpperCase();
}

/**
 * Tab order + short labels. Driven from this array (not from
 * SERVICE_LABELS) so:
 *   - the order is stable regardless of provider-list churn, and
 *   - label shortening ("Agent Platform" → "Agent", "Data Source" →
 *     "Datasource") is local to the picker and does not leak into
 *     the credential management list / table headers, which keep
 *     the longer canonical labels via SERVICE_LABELS.
 *
 * `service: "other"` is intentionally absent — no provider is
 * registered against it today; if one is added later, append the
 * tab here.
 */
const PROVIDER_TABS: ReadonlyArray<{
  service: CredentialServiceType;
  label: string;
}> = [
  { service: "llm", label: "LLM" },
  { service: "agent", label: "Agent" },
  { service: "search", label: "Search" },
  { service: "observability", label: "Observability" },
  { service: "integration", label: "Integration" },
  { service: "datasource", label: "Datasource" },
  { service: "calendar", label: "Calendar" },
  { service: "voice", label: "Voice" },
];

function ProviderPicker({ value, onChange }: ProviderPickerProps): ReactNode {
  // Default the open tab to the SERVICE of the currently-selected
  // provider (so editing an existing OpenAI credential opens "LLM",
  // not "LLM" by accident-of-being-first). Falls back to the first
  // tab when nothing is selected.
  const initialTab: CredentialServiceType = useMemo(() => {
    const svc = value ? getProviderService(value) : null;
    if (svc && PROVIDER_TABS.some((t) => t.service === svc)) return svc;
    return PROVIDER_TABS[0].service;
  }, [value]);
  const [activeTab, setActiveTab] = useState<CredentialServiceType>(initialTab);

  // Group providers by service ONCE. Constant input → constant output;
  // memoised mostly to keep the render path tidy.
  const byService = useMemo(() => {
    const map = new Map<CredentialServiceType, ProviderEntry[]>();
    for (const p of PROVIDERS) {
      const list = map.get(p.service);
      if (list) list.push(p);
      else map.set(p.service, [p]);
    }
    return map;
  }, []);

  const items: ProviderEntry[] = byService.get(activeTab) ?? [];

  return (
    <div className="rounded-md border">
      {/* Tab strip — horizontal, one tab per CredentialServiceType.
          Active tab gets the primary underline + foreground color; no
          shadcn Tabs primitive in the codebase, so this is a thin
          inline implementation. */}
      <div
        role="tablist"
        aria-label="Provider category"
        className="flex flex-wrap items-stretch gap-1 border-b px-1"
      >
        {PROVIDER_TABS.map((tab) => {
          const selected = activeTab === tab.service;
          return (
            <button
              key={tab.service}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveTab(tab.service)}
              className={cn(
                "relative whitespace-nowrap px-3 py-2 text-sm transition",
                "hover:text-foreground",
                selected
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
                // Underline indicator for the active tab — bottom-aligned
                // 2px bar, hugs the inner content edge so it visually
                // sits on the border-b of the strip itself.
                selected
                  && "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-primary after:content-['']",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="h-64 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No providers in this category.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {items.map((p) => {
              const selected: boolean = value === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => onChange(p.value)}
                  aria-pressed={selected}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition",
                    "hover:bg-accent hover:text-accent-foreground",
                    selected
                      ? "border-primary bg-accent ring-1 ring-primary"
                      : "border-border",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
                      avatarColorClass(p.value),
                    )}
                    aria-hidden
                  >
                    {providerInitials(p)}
                  </span>
                  <span className="truncate">{p.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

