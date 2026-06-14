import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp as pgTimestamp,
  jsonb,
  uuid,
  bigint,
  boolean,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  customType,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * All timestamp columns use `timestamp with time zone` (timestamptz).
 * PostgreSQL stores UTC internally; the driver returns timezone-aware
 * strings so JavaScript never misinterprets the value regardless of
 * the server's `timezone` setting.
 */
function timestamp(name: string) {
  return pgTimestamp(name, { withTimezone: true });
}

import type { ArtifactKind, ArtifactType } from "@/lib/domain/artifact";

/**
 * Postgres `bytea` column mapped to Node `Buffer`.
 */
const customBytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// Auth tables (better-auth managed)

export const UserTable = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    password: text("password"),
    image: text("image"),
    role: text("role").notNull().default("user"), // "admin" | "editor" | "user"
    banned: boolean("banned"),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires"),
    // Custom extension fields (registered via additionalFields in auth-instance)
    org: text("org"), // free-text org label
    imAccounts: jsonb("im_accounts"),  // { teams?: string, dingtalk?: string, ... }
    /** IANA timezone (e.g. "Asia/Shanghai") — the user's primary
     *  timezone. Null until first detected from the browser on session
     *  load (WorkspaceProvider). Source of truth for the
     *  `get_current_datetime` tool, the default timezone of newly
     *  created schedules, and all frontend timestamp display. When
     *  `timezoneFollowBrowser` is true the value is kept in sync with
     *  the browser on every session load; when false it is only ever
     *  changed by an explicit user save on the Profile page. */
    timezone: text("timezone"),
    /** When true, `timezone` is automatically synced to the browser's
     *  IANA zone on every session load (WorkspaceProvider). When false,
     *  `timezone` is a fixed value set by the user on the Profile page.
     *  Defaults to true for new users and existing users (migration). */
    timezoneFollowBrowser: boolean("timezone_follow_browser").notNull().default(true),
    /** Soft-delete timestamp; null = active. See docs/rbac.md. */
    deletedAt: timestamp("deleted_at"),
    deletedBy: uuid("deleted_by").references((): AnyPgColumn => UserTable.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    // Email is unique only among active (non-soft-deleted) users.
    uniqueIndex("user_email_active_idx")
      .on(t.email)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const SessionTable = pgTable("session", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: uuid("user_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
});

export const AccountTable = pgTable("account", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => UserTable.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const VerificationTable = pgTable("verification", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

/**
 * LoginEvent — append-only audit log for authentication events.
 *
 * Records sign-in (success / failure) and sign-out events. Used by
 * the admin "Login Events" tab for security auditing.
 *
 * Retention: application-level cleanup (default 90 days) runs at boot
 * or via scheduled task. No FK to session — sessions are ephemeral,
 * events are durable.
 */
export const LoginEventTable = pgTable(
  "login_event",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    userId: uuid("user_id").references(() => UserTable.id, {
      onDelete: "cascade",
    }),
    eventType: text("event_type").notNull(), // "sign_in" | "sign_in_failed" | "sign_out"
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    detail: text("detail"),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("login_event_user_idx").on(t.userId, t.createdAt.desc()),
    index("login_event_created_at_idx").on(t.createdAt.desc()),
  ],
);

// Nango domain tables

/**
 * DataSource — agent-facing data-access entity.
 *
 * One row = "an agent can read data from this source under this policy".
 * Holds the connection metadata (host / port / database / params) and
 * the access policy (readOnly, table allow/deny lists). Authentication
 * (user / password) lives in the linked `credential` row so a single
 * credential can back multiple data sources with different policies
 * (e.g. `prod_pg_readonly` vs `prod_pg_admin` over the same DB).
 *
 * The runtime-facing identifier is `name` (LLM passes this as the
 * `extract_dataset_by_sql.dataSourceName` parameter). See
 * docs/data-sources.md.
 */
export const DataSourceTable = pgTable("data_source", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),

  // Identity
  /** Stable LLM-facing identifier. Globally unique. Pattern matches
   *  `[a-z][a-z0-9_-]{1,62}` — enforced at the API layer. Doubles as
   *  the panel/list label; `description` carries any human-friendly
   *  blurb (`displayName` was removed in D-2.5 as redundant). */
  name: text("name").notNull(),
  /** Free-text description; injected into the agent's system prompt
   *  alongside `name` + `provider` so the LLM knows what this source
   *  is and when to use it. */
  description: text("description"),

  // Connection
  /** DataSourceId from `src/lib/data-sources/types.ts`. Validated at
   *  the API layer against the runtime registry. */
  provider: text("provider").notNull(),
  /** FK to the credential carrying user + password. RESTRICT on delete:
   *  the operator must remove referencing data sources first, otherwise
   *  cached datasets and live agent calls would silently break. */
  credentialId: uuid("credential_id")
    .notNull()
    .references(() => CredentialTable.id, { onDelete: "restrict" }),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  database: text("database").notNull(),
  /** Extra connection parameters appended to the URL (timezone,
   *  charset, connectTimeout, …). `Record<string, string>` — single-
   *  valued only; multi-value `?tag=a&tag=b` is not supported in V1. */
  params: jsonb("params")
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'::jsonb`),

  // Policy
  /** When true the runtime enforces read-only via app-level SQL parse
   *  AND a database-level `BEGIN READ ONLY` transaction. Default true:
   *  prod-safe-by-default. */
  readOnly: boolean("read_only").notNull().default(true),
  /** Whitelist of allowed table names (no schema qualification — V1
   *  assumes a single working schema per data source). null means no
   *  allowlist constraint (all tables permitted unless denied below). */
  tableAllowlist: jsonb("table_allowlist").$type<string[] | null>(),
  /** Blacklist of denied table names; takes precedence over the
   *  allowlist when both apply. Default empty array. */
  tableDenylist: jsonb("table_denylist")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),

  // State
  /** Disabled data sources are excluded from the agent's `Available
   *  data sources` system-prompt block and `extract_dataset_by_sql`
   *  rejects calls referencing them. */
  enabled: boolean("enabled").notNull().default(true),
  visibility: text("visibility").notNull().default("private"),

  // Audit
  createdBy: uuid("created_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  updatedBy: uuid("updated_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  uniqueIndex("data_source_name_unique").on(t.name),
  index("data_source_credential_idx").on(t.credentialId),
  index("data_source_provider_idx").on(t.provider),
]);

/**
 * Artifact — AI-generated content, organised as a self-referencing tree.
 *
 * Layout:
 *  - `parent_id IS NULL` rows are system-seeded top-level categories,
 *    one per `ArtifactType` (e.g. "Charts" for `type='chart'`).
 *    Immutable: API rejects update / delete / reparent.
 *  - User-created rows MUST have a non-null `parent_id` (a folder).
 *  - `kind = 'folder'` rows have `type / config` NULL; they're
 *    organisational nodes.
 *  - `kind = 'artifact'` rows are leaves: their renderable payload
 *    is computed on-demand from the bound workflow's output (see
 *    `lib/artifacts/bundle.ts`), NOT stored on the row.
 *
 * Invariants enforced at the service layer (see
 * `src/lib/artifacts/service.ts`), not by DB constraints, because
 * Drizzle's `CHECK` support is fragile across migrations.
 *
 * See docs/artifact-evolution.md.
 */
export const ArtifactTable = pgTable(
  "artifact",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    // Self-FK. NULL = top-level (system category).
    // ON DELETE RESTRICT so folders cannot disappear out from under
    // their children — the service layer is responsible for cascading
    // a user-initiated folder delete, after verifying it is empty.
    parentId: uuid("parent_id").references((): AnyPgColumn => ArtifactTable.id, {
      onDelete: "restrict",
    }),
    kind: text("kind").$type<ArtifactKind>().notNull(),
    // Only meaningful when kind = 'artifact'. NULL on folders.
    type: text("type").$type<ArtifactType>(),
    name: text("name").notNull(),
    description: text("description"),
    config: jsonb("config"),
    // Origin tracking for the Save-from-Outcomes flow (idempotency).
    sourceThreadId: text("source_thread_id"),
    sourceOutcomeId: text("source_outcome_id"),
    visibility: text("visibility").notNull().default("private"), // "private" | "shared"
    // Display order within the same parent (drag-reorder support).
    displayOrder: integer("display_order").notNull().default(0),

    /**
     * Workflow integration columns. Both NULL for artifacts not
     * backed by a workflow — HTML, PPT, image, code, report, and
     * standalone charts with inline data. Both non-NULL (enforced
     * at the service layer per the doc-comment above) for chart
     * artifacts produced by `save-as-workflow`.
     *
     * The FK is intentionally non-unique: a single workflow can
     * power many artifacts (1:N). Refresh re-executes the workflow,
     * engine resolves `spec.outputs`, and returns
     * `bundle[workflowOutputField]` for the artifact to render.
     */
    workflowId: uuid("workflow_id").references(() => WorkflowTable.id, {
      onDelete: "cascade",
    }),
    /** Names a key in `workflow.spec.outputs` — a top-level
     *  `Record<key, RefString>` map declared in the workflow spec. */
    workflowOutputField: text("workflow_output_field"),

    /**
     * Snapshot of the last successfully saved workflow output.
     * Populated on first save (initial execution) and updated only
     * via explicit "Save as snapshot" action. NULL for artifacts
     * without a snapshot yet.
     */
    snapshot: jsonb("snapshot"),
    /** UTC timestamp of the most recent snapshot write. */
    snapshotAt: timestamp("snapshot_at"),

    /**
     * Controls whether GET returns the stored snapshot or executes
     * the workflow live.
     *
     * 'snapshot' (default) — return `snapshot` data directly;
     *   falls back to live execution when `snapshot` is NULL.
     * 'live' — always re-execute the workflow on every GET.
     */
    viewMode: text("view_mode")
      .$type<"snapshot" | "live">()
      .notNull()
      .default("snapshot"),

    createdBy: uuid("created_by")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("artifact_parent_idx").on(t.parentId),
    index("artifact_created_by_idx").on(t.createdBy),
    index("artifact_type_idx").on(t.type),
    uniqueIndex("artifact_source_unique_idx")
      .on(t.sourceThreadId, t.sourceOutcomeId)
      .where(sql`${t.sourceThreadId} IS NOT NULL AND ${t.sourceOutcomeId} IS NOT NULL`),
    // Workflow reverse lookup: "show me all artifacts using workflow
    // X" — used for dependent-artifact discovery + admin cascade-
    // delete UX. Without this index, deleting a workflow row forces
    // a sequential scan over artifact to perform the
    // `ON DELETE SET NULL` action.
    index("artifact_workflow_id_idx").on(t.workflowId),
    // (created_by, parent_id, name) unique — same owner cannot have two
    // siblings with identical name. NULL parent_id is coalesced to empty
    // string in the unique index expression (added in migration SQL,
    // Drizzle does not model COALESCE in unique indexes natively).
  ],
);

/**
 * Dashboard — composition of multiple artifacts into a presentable
 * page, organised in a separate self-referencing tree.
 *
 *  - `kind = 'folder'`: organisational node. Arbitrary nesting depth.
 *    No top-level seed (unlike artifact categories) — users create
 *    folders as they like.
 *  - `kind = 'dashboard'`: leaf. Carries `slug` (URL) + `layout`
 *    (cached projection of the dashboard_artifact rows). Can be
 *    published (`published_at IS NOT NULL`), making it readable by
 *    any authenticated user in the tenant.
 *
 * See docs/artifact-evolution.md.
 */
export const DashboardTable = pgTable(
  "dashboard",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => DashboardTable.id,
      { onDelete: "restrict" },
    ),
    kind: text("kind").$type<"folder" | "dashboard">().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Only when kind = 'dashboard'. Globally unique; user-editable.
    slug: text("slug"),
    // Only when kind = 'dashboard'. Cached layout (mirror of
    // dashboard_artifact rows + per-tile grid coords).
    layout: jsonb("layout"),
    publishedAt: timestamp("published_at"),
    visibility: text("visibility").notNull().default("private"),
    displayOrder: integer("display_order").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("dashboard_parent_idx").on(t.parentId),
    index("dashboard_created_by_idx").on(t.createdBy),
    // Partial unique index on slug (only where IS NOT NULL) is added
    // in migration SQL; Drizzle does not express WHERE clauses on
    // unique indexes here.
  ],
);

/**
 * DashboardArtifact — many-to-many association between dashboards
 * and the artifacts they render, plus per-tile grid position. A
 * single artifact may appear multiple times in the same dashboard
 * (e.g. a thumbnail + a full-size view); each row has a surrogate
 * `id` to allow that.
 *
 * Cascading:
 *  - Delete dashboard ⇒ DELETE CASCADE here (the dashboard owns its
 *    layout).
 *  - Delete artifact while referenced ⇒ RESTRICT. Users must remove
 *    the artifact from every dashboard before deletion.
 *
 * See docs/artifact-evolution.md.
 */
export const DashboardArtifactTable = pgTable(
  "dashboard_artifact",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => DashboardTable.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => ArtifactTable.id, { onDelete: "restrict" }),
    gridX: integer("grid_x").notNull(),
    gridY: integer("grid_y").notNull(),
    gridW: integer("grid_w").notNull(),
    gridH: integer("grid_h").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("dashboard_artifact_dashboard_idx").on(t.dashboardId),
    index("dashboard_artifact_artifact_idx").on(t.artifactId),
  ],
);

// Inferred types

export type UserEntity = typeof UserTable.$inferSelect;
export type SessionEntity = typeof SessionTable.$inferSelect;
export type AccountEntity = typeof AccountTable.$inferSelect;
export type DataSourceEntity = typeof DataSourceTable.$inferSelect;

/**
 * SshServer — agent-facing remote-shell entity. Connection metadata + access policy.
 * Auth lives in linked `credential` row. Runtime-facing identifier is `name`.
 *
 * See docs/ssh.md.
 */
export const SshServerTable = pgTable("ssh_server", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),

  // Identity
  /** Stable LLM-facing identifier. Globally unique. Pattern: `[a-z][a-z0-9_-]{1,62}`. */
  name: text("name").notNull(),
  /** Free-text description; injected into the agent's system prompt. */
  description: text("description"),

  // Connection
  /** FK to credential (basic_auth or private_key). RESTRICT on delete. */
  credentialId: uuid("credential_id")
    .notNull()
    .references(() => CredentialTable.id, { onDelete: "restrict" }),
  host: text("host").notNull(),
  port: integer("port").notNull().default(22),
  /** Pinned host-key fingerprint (`SHA256:<base64>`). Verified on every
   *  connect against the admin-confirmed value. See docs/ssh.md. */
  knownHostFingerprint: text("known_host_fingerprint").notNull(),

  // Policy (enforced at runtime by lib/ssh/policy.ts)
  /** Allowed command regex patterns. Null = no constraint; [] = deny all. Anchor with `^` for prefix matches. */
  commandAllow: jsonb("command_allow").$type<string[] | null>(),
  /** Blacklist of denied command regex patterns. Takes precedence over allowlist. */
  commandDeny: jsonb("command_deny")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),

  // Execution
  /** When true (default), commands are wrapped as `bash -lc '...'`
   *  so the host's profile scripts (`/etc/profile`, `~/.bash_profile`,
   *  `/etc/profile.d/*.sh`) are sourced — same PATH / env you get
   *  when SSHing in interactively. Turn off for hosts without bash
   *  (Alpine, busybox, network devices) or when profile output
   *  pollutes stdout. */
  loginShell: boolean("login_shell").notNull().default(true),

  // State
  /** Disabled rows are excluded from the agent's `Available SSH
   *  hosts` system-prompt block and `run_ssh_command` rejects calls
   *  referencing them. */
  enabled: boolean("enabled").notNull().default(true),
  visibility: text("visibility").notNull().default("private"),

  // Audit
  createdBy: uuid("created_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  updatedBy: uuid("updated_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  uniqueIndex("ssh_server_name_unique").on(t.name),
  index("ssh_server_credential_idx").on(t.credentialId),
]);

export type SshServerEntity = typeof SshServerTable.$inferSelect;
export type ArtifactEntity = typeof ArtifactTable.$inferSelect;

export type { ArtifactType, ArtifactKind };
export type DashboardEntity = typeof DashboardTable.$inferSelect;
export type DashboardArtifactEntity = typeof DashboardArtifactTable.$inferSelect;
export type DashboardKind = "folder" | "dashboard";
export type VisibilityType = "private" | "shared";
export type UserRole = "admin" | "user";

/** Built-in agent system-role enum. `null` = regular user-authored
 *  agent. See AGENTS.md ("Supervisor + agent role enum"). */
export type AgentRole = "supervisor" | "secretary" | "evaluator";
export type ImAccounts = { teams?: string; dingtalk?: string; wechat?: string; slack?: string };

// BuiltIn Agent tables

/**
 * Credential — encrypted credential store for all sensitive secrets.
 *
 * Covers API keys, bearer tokens, basic-auth pairs, and OAuth
 * client credentials.  The entire secret payload is encrypted with
 * AES-256-GCM before storage; encryption keys live in the
 * CREDENTIAL_ENCRYPTION_KEYRING environment variable and never touch
 * the database. See docs/key-rotation.md.
 *
 * type values and their expected payload shapes:
 *
 *   "api_key"      → { key: string }
 *                    e.g. OpenAI, Anthropic, Exa, Tavily
 *
 *   "bearer_token" → { token: string }
 *                    e.g. Agno auth token, Mastra auth token
 *
 *   "basic_auth"   → { username: string; password: string }
 *                    SSH (password-auth) reuses this shape.
 *
 *   "oauth_client" → { clientId: string; clientSecret: string; tokenUrl: string }
 *
 *   "keypair"      → { publicKey: string; secretKey: string }
 *                    Two encrypted fields side-by-side.
 *
 *   "private_key"  → { username: string; privateKey: string; passphrase?: string }
 *                    SSH (key-auth). See lib/ssh/credential-schema.ts.
 *
 * metadata holds non-sensitive display information so list queries never need
 * to decrypt:
 *   - keyPreview:  last-four characters of the key, e.g. "...x8Qz"
 *   - expiresAt:   ISO-8601 expiry date, if known
 *   - extra:       any other provider-specific display hints
 *
 * provider is a free-text label used for grouping in the UI
 * (e.g. "openai", "anthropic", "agno", "exa").
 *
 * enabled: false hides the credential from runtime lookups without deleting it.
 */
export const CredentialTable = pgTable(
  "credential",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),

    /** Human-readable label, e.g. "OpenAI Production Key". */
    name: text("name").notNull(),

    /**
     * Credential category. See `CREDENTIAL_TYPES` below for the
     * authoritative list; payload shapes documented in the table
     * doc-comment above.
     */
    type: text("type").notNull(),

    /**
     * Service category — determines UI placement and which module resolves the credential.
     * llm = LLM provider; search = retrieval API; agent = backend runtime;
     * observability = tracing; integration = external systems (MCP, SSH);
     * datasource = external DB; other = anything else.
     */
    serviceType: text("service_type").notNull(),

    /**
     * Optional provider / system tag for grouping, e.g. "openai", "exa", "agno".
     * Not used for runtime logic; purely for UI organisation.
     */
    provider: text("provider"),

    /**
     * AES-256-GCM ciphertext of JSON.stringify(payload).
     * Format: "<iv_hex>:<authTag_hex>:<ciphertext_base64>"
     */
    encryptedPayload: text("encrypted_payload").notNull(),

    /**
     * Non-sensitive display metadata stored in plain text.
     * Never put secret material here.
     */
    metadata: jsonb("metadata").$type<CredentialMetadata>(),

    enabled: boolean("enabled").notNull().default(true),

    /** REST API base URL for self-hosted backends; null for public-cloud APIs with fixed URLs. */
    restUrl: text("rest_url"),

    /** AG-UI SSE endpoint template (agno, Mastra). Must contain `{agentId}` placeholder,
     *  e.g. `http://host:7878/agents/{agentId}/agui`. Null for non-AG-UI backends. */
    aguiUrl: text("agui_url"),

    createdBy: uuid("created_by").references(() => UserTable.id, {
      onDelete: "cascade",
    }),
    /** Last user who modified this row (multi-admin deployments). See docs/rbac.md. */
    updatedBy: uuid("updated_by").references(() => UserTable.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("credential_type_idx").on(t.type),
    index("credential_provider_idx").on(t.provider),
  ],
);

/** Non-sensitive display hints stored alongside the encrypted payload. */
export interface CredentialMetadata {
  /** Last few characters of the key for identification, e.g. "...x8Qz". */
  keyPreview?: string;
  /** ISO-8601 expiry date, if the credential has a known TTL. */
  expiresAt?: string;
  /** Any other provider-specific display hints. */
  extra?: Record<string, string>;
}

export const CREDENTIAL_TYPES = [
  "api_key",
  "bearer_token",
  "basic_auth",
  "oauth_client",
  "keypair",
  "private_key",
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const CREDENTIAL_SERVICE_TYPES = [
  "llm",
  "search",
  "agent",
  "observability",
  "integration",
  "datasource",
  "other",
] as const;

export type CredentialServiceType = (typeof CREDENTIAL_SERVICE_TYPES)[number];

export type CredentialEntity = typeof CredentialTable.$inferSelect;

/**
 * McpServer — an MCP (Model Context Protocol) server connection.
 *
 * Tools are discovered by connecting to the server at save time and can be
 * refreshed on demand. The `tools` field stores the latest confirmed snapshot
 * returned by the server. On each refresh the new list is diffed against the
 * stored one and presented to the user; after confirmation the snapshot is
 * replaced wholesale, with `enabled` values carried over for tools that kept
 * the same name.
 *
 * visibility: "private" — visible to the creator only;
 *             "public"  — available to all users.
 */
export const McpServerTable = pgTable("mcp_server", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").notNull(),         // "sse" | "http"
  url: text("url").notNull(),
  /** Non-sensitive request headers forwarded to the MCP server,
   *  e.g. { "X-Tenant-Id": "acme" }.
   *  Do NOT put auth tokens here — use credentialId instead. */
  headers: jsonb("headers").$type<Record<string, string>>(),
  /** Reference to the credential used for authentication.
   *  null means the server requires no authentication. */
  credentialId: uuid("credential_id").references(() => CredentialTable.id, {
    onDelete: "cascade",
  }),
  /** The request header name the credential token is injected into.
   *  Defaults to "Authorization" at runtime when credentialId is set.
   *  Use a custom value for non-standard headers, e.g. "X-API-Key". */
  credentialHeader: text("credential_header"),
  /** Whether the entire server (and all its tools) is active. */
  enabled: boolean("enabled").notNull().default(true),
  /** Latest snapshot of tools returned by the server.
   *  null until the first successful discovery scan. */
  tools: jsonb("tools").$type<McpToolSnapshot[]>(),

  // Server metadata captured during the MCP `initialize` handshake.
  // Populated by /api/mcp-servers/[id]/discover; null until the first
  // successful discovery. NOT user-editable — these are observed
  // properties of the upstream server, not configuration.
  /** `serverInfo.name` from initialize (required by MCP spec). */
  serverName: text("server_name"),
  /** `serverInfo.version` from initialize (required by MCP spec). */
  serverVersion: text("server_version"),
  /** `serverInfo.title` — optional human-readable display name
   *  (newer MCP spec). UI prefers this over `serverName` when present. */
  serverTitle: text("server_title"),
  /** `serverInfo.description` — optional one-line description of
   *  what the server is (newer MCP spec). Surfaced as the secondary
   *  line in the MCP panel. */
  serverDescription: text("server_description"),
  /** Top-level `instructions` from the initialize result — optional
   *  usage hint (longer-form than description) telling clients /
   *  LLMs how to use the server. Shown on the server detail view. */
  serverInstructions: text("server_instructions"),

  visibility: text("visibility").notNull().default("private"),
  createdBy: uuid("created_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  /** Last user who modified this row. See docs/rbac.md. */
  updatedBy: uuid("updated_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Skill — a reusable prompt / scripted capability stored as a file-system resource.
 *
 * Each skill lives in a directory that follows the standard layout:
 *   <path>/SKILL.md          — frontmatter + body (required)
 *   <path>/scripts/          — helper scripts (optional)
 *   <path>/references/       — reference material (optional)
 *   <path>/assets/           — static assets (optional)
 *   <path>/evals/            — structured evaluation cases (optional, Skills 2.0)
 *
 * SKILL.md must start with a YAML frontmatter block declaring at least
 * `name` and `description`, e.g.:
 *
 *     ---
 *     name: csv-data-summary
 *     description: Summarize a CSV file with column stats.  Use when ...
 *     ---
 *     # Body markdown ...
 *
 * source:
 *   "builtin" — shipped with the application.  Authored under
 *               `<repo>/skills/<dirname>/`, baked into
 *               `dist/builtin-skills.json` at build time, reconciled
 *               into the DB at boot.
 *   "local"   — user-created skill.  Created via `POST /api/skills`
 *               (or future `POST /api/skills/install` ZIP upload);
 *               purely DB-resident.
 *
 * name + description are parsed from the SKILL.md frontmatter and
 * cached here for list queries; skillMd holds the full text.
 * checksum is the sha256 over (skillMd ‖ canonical helper files) used
 * by boot reconcile to skip no-op updates on built-ins.
 *
 * visibility: "private" — visible to the creator only;
 *             "public"  — available to all users.
 */
export const SkillTable = pgTable("skill", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),

  /** Parsed from the SKILL.md `name` frontmatter field. */
  name: text("name").notNull(),

  /** Parsed from the SKILL.md `description` frontmatter field. */
  description: text("description"),

  /** Parsed from the SKILL.md `version` frontmatter field; default "1.0.0".
   *  Informational — used for "what version of csv-summary is currently
   *  deployed?" in admin UI; not consumed by the runtime. */
  version: text("version").notNull().default("1.0.0"),

  /** Full content of SKILL.md (frontmatter + body), stored verbatim for UI. */
  skillMd: text("skill_md").notNull(),

  /** SHA-256 hex digest of skillMd; null = pre-checksum legacy row. */
  checksum: text("checksum"),

  /** Where the skill comes from. */
  source: text("source").notNull().default("local"), // "builtin" | "local"

  enabled: boolean("enabled").notNull().default(true),

  visibility: text("visibility").notNull().default("private"), // "private" | "public"

  createdBy: uuid("created_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  /** Last user who modified this row. See docs/rbac.md. */
  updatedBy: uuid("updated_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * SkillFile — helper file (references / scripts / assets / evals) bound
 * to a skill. Stored as a bytea blob in PG. See docs/skills.md.
 *
 * `path` is a logical relative POSIX path (e.g. `references/output.md`),
 * NOT a filesystem path. There is no actual filesystem at runtime, so
 * path-traversal is impossible by construction — invalid path strings
 * are rejected at the API edge.
 *
 * Caps enforced by the application layer (not DB CHECK):
 *   - per-file:   ≤ 256 KB
 *   - per-skill:  ≤ 100 files, total ≤ 10 MB
 */
export const SkillFileTable = pgTable(
  "skill_file",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => SkillTable.id, { onDelete: "cascade" }),
    /** Logical relative path; one of references/, scripts/, assets/, evals/ subdirs. */
    path: text("path").notNull(),
    /** Raw bytes of the helper file. PG TOAST handles compression. */
    content: customBytea("content").notNull(),
    /** Pre-computed byte length, matches `length(content)`. */
    size: integer("size").notNull(),
    /** Detected MIME type (e.g. `text/markdown`, `image/png`). Null when undetermined. */
    contentType: text("content_type"),
    updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("skill_file_skill_path_idx").on(t.skillId, t.path),
    index("skill_file_skill_id_idx").on(t.skillId),
  ],
);

export type SkillFileEntity = typeof SkillFileTable.$inferSelect;

/**
 * BuiltinAgent — user-defined AI agent configuration (model, prompt, tools).
 * visibility: "private" = creator only; "public" = all users.
 */
export const BuiltinAgentTable = pgTable("builtin_agent", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),

  /** System-agent role; nullable. DB CHECK pins the enum (see migration
   *  0003) — TS type narrows in client + server. */
  role: text("role").$type<AgentRole | null>(),

  name: text("name").notNull(),
  description: text("description"),

  /**
   * Optional visual identifier — a single emoji character (e.g. "🤖")
   * picked by the user when authoring the agent. Rendered next to the
   * agent name in the left panel and (future) chat header so visually
   * scanning multiple agents is faster than reading names. NULL means
   * "use the default emoji" — chosen by the renderer, not the DB.
   *
   * Stored as the raw Unicode character (1-4 codepoints, ~4-12 bytes),
   * NOT as Apple's `unified` codepoint string. This keeps the DB
   * representation human-readable and frees us from CDN dependencies
   * for rendering — the browser draws the glyph with its native
   * emoji font.
   */
  icon: text("icon"),

  /** LLM model identifier, e.g. "gpt-4o", "claude-3-5-sonnet-20241022". */
  model: text("model").notNull(),
  /** Model provider slug, e.g. "openai", "anthropic". Derived from the linked credential. */
  modelProvider: text("model_provider").notNull(),
  /**
   * Required FK to the credential used for this agent's LLM API key.
   * Runtime must resolve the model key from this bound credential.
   */
  credentialId: uuid("credential_id").notNull().references(() => CredentialTable.id),

  /** System prompt sent to the model on every run. */
  prompt: text("prompt"),

  /** Sampling temperature (0.0 – 1.0). null = use provider default. */
  temperature: text("temperature"),   // stored as text to avoid float precision issues; parsed at runtime
  /** Maximum number of tokens the model may generate. null = provider default. */
  maxTokens: integer("max_tokens"),

  /** Maximum number of tool-call steps per run (default 5). */
  maxSteps: integer("max_steps").notNull().default(5),

  /** Tool choice strategy: "auto" | "required" | "none". Default "auto". */
  toolChoice: text("tool_choice").notNull().default("auto"),

  /** Whether conversation memory is enabled (reserved for future use). */
  memoryEnabled: boolean("memory_enabled").notNull().default(false),
  /** Number of recent conversation turns to retain. null = unlimited. */
  memoryWindowSize: integer("memory_window_size"),

  enabled: boolean("enabled").notNull().default(true),

  visibility: text("visibility").notNull().default("private"), // "private" | "public"

  createdBy: uuid("created_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  /** Last user who modified this row. See docs/rbac.md. */
  updatedBy: uuid("updated_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  // Per-role uniqueness — evaluator intentionally unconstrained.
  // NULL createdBy (post owner hard-purge) treated as distinct.
  uniqueIndex("builtin_agent_one_supervisor_per_user_idx")
    .on(t.createdBy)
    .where(sql`${t.role} = 'supervisor'`),
  uniqueIndex("builtin_agent_one_secretary_per_user_idx")
    .on(t.createdBy)
    .where(sql`${t.role} = 'secretary'`),
]);

/**
 * Junction table: agent → tools. `toolType` discriminates which FK is populated.
 * FK columns use SET NULL on delete (orphans surfaced for cleanup).
 * `order` controls injection order.
 */
export const BuiltinAgentToolTable = pgTable(
  "builtin_agent_tool",
  {
    // Bigint identity for junction table.
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    agentId: uuid("agent_id")
      .notNull()
      .references(() => BuiltinAgentTable.id, { onDelete: "cascade" }),

    /** Discriminator: "mcp_server" | "mcp_tool" | "skill" | "builtin_tool" | "datasource" | "ssh_server" */
    toolType: text("tool_type").notNull(),

    // MCP
    /** Set for toolType "mcp_server" and "mcp_tool". */
    mcpServerId: uuid("mcp_server_id").references(() => McpServerTable.id, {
      onDelete: "cascade",
    }),
    /** Set for toolType "mcp_tool" only — matches McpToolSnapshot.name. */
    mcpToolName: text("mcp_tool_name"),

    // Skill
    /** Set for toolType "skill". */
    skillId: uuid("skill_id").references(() => SkillTable.id, {
      onDelete: "cascade",
    }),

    // Builtin
    /** Set for toolType "builtin_tool" — name of the built-in tool, e.g. "web_search". */
    builtinTool: text("builtin_tool"),

    // DataSource
    /** Set for toolType "datasource". SET NULL on delete (same orphan-row pattern as MCP/Skill). */
    dataSourceId: uuid("data_source_id").references(() => DataSourceTable.id, {
      onDelete: "cascade",
    }),

    // SshServer
    /** Set for toolType "ssh_server". Binding any ssh_server auto-mounts run_ssh_command + list_ssh_hosts. SET NULL on delete. */
    sshServerId: uuid("ssh_server_id").references(() => SshServerTable.id, {
      onDelete: "cascade",
    }),

    /** Display / injection order within the agent. Lower values come first. */
    order: integer("order").notNull().default(0),
  },
  (t) => [
    index("builtin_agent_tool_agent_idx").on(t.agentId),
    // Reverse-lookup indexes: find which agents use a given resource.
    index("builtin_agent_tool_mcp_server_idx").on(t.mcpServerId),
    index("builtin_agent_tool_mcp_tool_idx").on(t.mcpServerId, t.mcpToolName),
    index("builtin_agent_tool_skill_idx").on(t.skillId),
    index("builtin_agent_tool_data_source_idx").on(t.dataSourceId),
    index("builtin_agent_tool_ssh_server_idx").on(t.sshServerId),
  ],
);

/**
 * Workflow — directed acyclic graph (DAG) of data-producing tool /
 * agent nodes that produces a structured output bundle.
 *
 * Authoring path: the save-as-workflow pipeline captures a chat
 * tool chain into a stored workflow. Modifications go back through
 * chat — there is no standalone editor page, no in-place edit tool;
 * a new outcome plus the next "Save" extracts a fresh workflow.
 *
 * Schema follows the same ownership / visibility shape as
 * `builtin_agent` and `skill`, so the shared resource-permission
 * helpers (canEditResource / canDeleteResource / canChangeVisibility)
 * apply uniformly. visibility "public" means any tenant user can
 * view; only the owner edits / deletes.
 *
 * The full spec — nodes, refs, top-level `outputs` map,
 * `refReconAlgorithm` tag, execution config — lives in the `spec`
 * JSONB column. The `workflow_spec_gin_idx` GIN index supports
 * reverse-dependency queries via JSONB path operators.
 *
 * No `source` column: every workflow today comes from the
 * save-as-workflow pipeline. Adding a separate column is purely
 * additive if Nango ever ships built-in workflows. No
 * `is_published` either — every row is implicitly published.
 *
 * See docs/workflow-architecture.md.
 */
export const WorkflowTable = pgTable(
  "workflow",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),

    name: text("name").notNull(),
    description: text("description"),

    /**
     * Full workflow spec — DAG, refs, outputs map, execution config.
     * Stored untyped at the column level; the workflows subsystem
     * (`src/lib/workflows/spec/schema.ts`) owns the Zod validator
     * that gates writes. See docs/workflow-architecture.md.
     */
    spec: jsonb("spec").notNull(),

    visibility: text("visibility").notNull().default("private"), // "private" | "public"

    createdBy: uuid("created_by").references(() => UserTable.id, {
      onDelete: "cascade",
    }),
    /** Last user who modified this row. See docs/rbac.md. */
    updatedBy: uuid("updated_by").references(() => UserTable.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    // Owner lookup: "list my workflows" + cascading-delete UX.
    index("workflow_created_by_idx").on(t.createdBy),

    // Partial index on the 'public' subset — used by tenant-wide
    // "what's shared with me?" listing. Private rows aren't indexed
    // here; the createdBy index covers owner queries.
    index("workflow_visibility_idx")
      .on(t.visibility)
      .where(sql`${t.visibility} = 'public'`),

    // GIN index on spec with jsonb_path_ops opclass enables fast
    // reverse-dependency queries:
    //   "Which workflows use data source X / MCP tool Y / agent Z?"
    // jsonb_path_ops trades index size for containment-query speed;
    // we don't need the full jsonb_ops operator set.
    index("workflow_spec_gin_idx").using(
      "gin",
      t.spec.op("jsonb_path_ops"),
    ),
  ],
);

export type WorkflowEntity = typeof WorkflowTable.$inferSelect;

// Inferred types

/** A single tool entry in the McpServer tools snapshot. */
export interface McpToolSnapshot {
  name: string;
  description?: string;
  /** Raw input_schema returned by the MCP server (JSON Schema object). */
  input_schema?: Record<string, unknown>;
  enabled: boolean;
}

export type McpServerEntity = typeof McpServerTable.$inferSelect;
export type SkillEntity = typeof SkillTable.$inferSelect;
export type SkillSource = "builtin" | "local";
export type BuiltinAgentEntity = typeof BuiltinAgentTable.$inferSelect;
export type BuiltinAgentToolEntity = typeof BuiltinAgentToolTable.$inferSelect;
export type AgentToolType =
  | "mcp_server"
  | "mcp_tool"
  | "skill"
  | "builtin_tool"
  | "datasource"
  | "ssh_server";

// Runner — entity_run + entity_run_event

//
// Every act of "let entity X do task Y" — sync chat, super-agent
// delegation, async task, scheduled trigger, debate child run — is
// materialised as one `entity_run` row. The corresponding event stream
// (text deltas, tool calls, artifacts, …) lives in `entity_run_event`,
// append-only with a monotonic `seq` per run.
//
// The "entity" prefix mirrors `EntityDescriptor` / `EntityKind` /
// `entity-catalog` and keeps polymorphism explicit: a row can describe
// an agent / team / workflow run, not just an agent.
//
// Long-form design: docs/orchestrator.md.

/**
 * One execution of an entity. Status transitions:
 *
 *   queued → running → succeeded | failed | cancelled
 *                    ↘ awaiting_input → running (resumed)
 *                    ↘ paused → running (resumed)
 */
export const EntityRunTable = pgTable(
  "entity_run",
  {
    // UUIDv7 (PG18 built-in) for time-ordered pagination.
    id: uuid("id").primaryKey().notNull().default(sql`uuidv7()`),

    /** Parent run for fan-out (debate child) / orchestrator delegation.
     *  `null` for top-level runs. Cascade delete keeps the run forest
     *  consistent — losing a parent invalidates its children. */
    parentRunId: uuid("parent_run_id"),

    /** User-facing conversation thread this run belongs to. Null for
     *  one-off / scheduled runs that don't surface in a chat thread. */
    threadId: uuid("thread_id"),

    /** Who triggered this run. */
    initiator: text("initiator").notNull(), // "user" | "orchestrator" | "schedule" | "system"

    /** Entity reference — same vocabulary as EntityDescriptor. */
    entityId: text("entity_id").notNull(),
    entityKind: text("entity_kind").notNull(),     // "agent" | "team" | "workflow"
    entitySource: text("entity_source").notNull(), // "backend" | "builtin"

    /** Backend credential. Null for `entitySource = "builtin"`. SET NULL
     *  on delete so an admin removing a credential doesn't cascade-
     *  destroy historical runs (we keep the forensic trail). */
    credentialId: uuid("credential_id").references(() => CredentialTable.id, {
      onDelete: "cascade",
    }),

    /** Mode of dispatch — also drives how the consumer consumes events. */
    mode: text("mode").notNull(), // "sync" | "async" | "scheduled"

    /** Schedule that triggered this run. Non-null only when
     *  `initiator = 'schedule'`. SET NULL on schedule delete so a
     *  removed schedule doesn't cascade-destroy its historical runs
     *  (we keep the audit trail). Indexed `(schedule_id, created_at
     *  DESC)` for the per-schedule history list in ScheduleEditor. */
    scheduleId: uuid("schedule_id"),

    /** Lifecycle state. */
    status: text("status").notNull(), // queued|running|awaiting_input|paused|succeeded|failed|cancelled

    /** Input payload. `inputTask` is the human / orchestrator-readable
     *  prompt; `inputContext` / `inputParams` are structured extensions
     *  used by built-in agents and (future) workflow runs. */
    inputTask: text("input_task").notNull(),
    inputContext: jsonb("input_context"),
    inputParams: jsonb("input_params"),

    /** Output summary (one-paragraph natural-language) and any
     *  structured artifacts (chart ids, dashboard ids, …) produced by
     *  the run. The full event timeline lives in
     *  {@link EntityRunEventTable}. */
    outputSummary: text("output_summary"),
    outputArtifacts: jsonb("output_artifacts"),

    /** On failure: short message for UI; structured details for ops. */
    errorMessage: text("error_message"),
    errorDetails: jsonb("error_details"),

    /** Ownership — runs are visible to the owner only. NOT necessarily
     *  the entity's owner (think "user A delegates to entity owned by
     *  user B"). Cascade-delete with the user removes the user's run
     *  history along with their account. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),

    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    deadline: timestamp("deadline"),

    createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("entity_run_owner_idx").on(t.ownerId),
    index("entity_run_thread_idx").on(t.threadId),
    index("entity_run_parent_idx").on(t.parentRunId),
    index("entity_run_status_idx").on(t.status),
    index("entity_run_created_at_idx").on(t.createdAt),
    // Per-schedule history pagination — DESC matches the
    // RecentRuns list's "newest first" ordering and keeps the
    // index scan one-sided.
    index("entity_run_schedule_idx").on(t.scheduleId, t.createdAt.desc()),
    // Workflow runs share `entity_run` via the polymorphic
    // `(entity_kind, entity_source, entity_id)` shape. This partial
    // index covers the two access patterns that local DAG workflows
    // need without bloating the index over the much larger
    // entity_kind='agent' subset:
    //   - "list runs of workflow X"        — equality on entity_id
    //   - "find stranded workflow runs at boot" — sequential scan
    //     filtered by entity_kind + status (covered by status_idx
    //     intersection; this index narrows the entity-kind dimension)
    // entity_source='builtin' distinguishes local DAG workflows
    // (this codebase's data engine) from backend platform workflows
    // (agno / Mastra / Dify).
    index("entity_run_workflow_lookup_idx")
      .on(t.entityKind, t.entitySource, t.entityId)
      .where(
        sql`${t.entityKind} = 'workflow' AND ${t.entitySource} = 'builtin'`,
      ),
  ],
);

/**
 * Append-only event stream produced by a run. `seq` monotonically
 * increases per run starting from 0. Retention horizon is ~7 days
 * (cleanup job TBD); the durable summary survives in
 * {@link EntityRunTable.outputSummary}.
 *
 * `payload` shape varies by `type`:
 *   - "started"          : { ts }
 *   - "message"          : { messageId, role, text }    (full coalesced)
 *   - "reasoning"        : { messageId, text }          (full coalesced)
 *   - "tool_call_chunk"  : { toolCallId, toolName, args } (full coalesced)
 *   - "tool_call_result" : { toolCallId, content }
 *   - "finished"         : { summary, output? }
 *   - "error"            : { message, errorType? }
 *
 * Coalescing: `message` / `reasoning` / `tool_call_chunk` rows all
 * hold the FULL assembled text for one continuous segment, not
 * per-token deltas. The browser still sees real-time deltas on the
 * wire — only storage skips them. See docs/runner-events.md.
 * If a tool call splits a single LLM "turn" into pre-tool and
 * post-tool text, that surfaces as TWO `message` rows sharing one
 * `messageId` but different `seq`s; this is intentional and faithful
 * to the underlying conversation flow.
 *
 * @see docs/runner-events.md
 */
export const EntityRunEventTable = pgTable(
  "entity_run_event",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => EntityRunTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    ts: timestamp("ts").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
  ],
);

export type EntityRunEntity = typeof EntityRunTable.$inferSelect;
export type EntityRunEventEntity = typeof EntityRunEventTable.$inferSelect;
export type EntityRunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";
export type EntityRunMode = "sync" | "async" | "scheduled";
export type EntityRunInitiator = "user" | "orchestrator" | "schedule" | "system";
export type EntityRunEventType =
  | "started"
  | "message"
  | "reasoning"
  | "tool_call_chunk"
  | "tool_call_result"
  | "finished"
  | "error"
  /** Build-time capability skip — the agent attempted to bind some
   *  capability (MCP server, model, supervisor catalog, …) and the
   *  runtime degraded gracefully (logged + continued without it).
   *  Surfaces in admin run forensics so operators can attribute a
   *  "missing tool" symptom to its precise cause without grepping
   *  process logs. Payload:
   *    {
   *      ref: string,         // mcpServerId / agentId / "<provider>/<model>"
   *      refName: string | null, // human-readable name, null when entity
   *                              // is already gone (deleted MCP server,
   *                              // deleted agent, etc.)
   *      reason: string,      // short event tag (`mcp_borrow_failed`,
   *                           //   `spec_skip`, `model_resolve_failed`, …) —
   *                           //   the prefix encodes the capability
   *                           //   axis (mcp_* / spec_* / model_* /
   *                           //   supervisor_*), so we don't store
   *                           //   a separate `capability` field.
   *      message: string,     // human-readable detail (typically err.message)
   *    }
   *
   *  Written by `dispatch/builtin.ts::recordDegradation` at agent
   *  build time. NOT a fatal terminal event (the run continues with
   *  reduced capability) — admins use it as a diagnostic complement
   *  to the structured log lines, not a replacement.
   *
   *  Historical name: this event used to be `capability_degraded`
   *  with a separate `capability` field in the payload; renamed +
   *  reshaped in a migration that DELETEd the old rows. */
  | "degraded"
  /** Workflow engine node-level lifecycle events (D4a). Emitted by
   *  the workflow engine via `emitEvent`, persisted only on
   *  `forceFresh: true` paths (refresh — deliberate user action).
   *  GET paths use `noopEmitEvent` so passive artifact views don't
   *  pollute the run log.
   *
   *  Run-level workflow events (`workflow_started` /
   *  `workflow_completed` / `workflow_failed`) map to the existing
   *  `started` / `finished` / `error` types so they share the
   *  vocabulary with chat / async runs. Node-level events get
   *  dedicated types here so admin run forensics can render them
   *  as a step-by-step node timeline without overloading
   *  `tool_call_chunk` semantics (those imply LLM token-stream
   *  coalescing, which is wrong for a deterministic workflow
   *  node).
   *
   *  Payload: the full `WorkflowEngineEvent` JSON (sans `runId`,
   *  already on the row) — nodeId, attempt, durationMs, cached,
   *  outputs / errorCode + message as appropriate.
   *
   *  @see lib/artifacts/workflow-run-recorder.ts
   *  @see lib/workflows/engine/index.ts (WorkflowEngineEvent) */
  | "workflow_node_attempt_started"
  | "workflow_node_attempt_failed"
  | "workflow_node_completed";

// Process boot tracking — used by recoverStrandedRuns to identify zombies

/**
 * One row per Node process boot. Inserted by `recordProcessBoot` from
 * the instrumentation hook before the app accepts requests.
 *
 * Boot epoch anchor for stranded run recovery.
 *
 * CONTRACT: append-only. We do not prune — rows are tiny (~100 B) and
 * the table is dev-forensic. If retention ever matters, add
 * `DELETE WHERE started_at < NOW() - INTERVAL '90 days'` at boot.
 */
export const ProcessBootTable = pgTable("process_boot", {
  // Bigint identity for append-only log.
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  startedAt: timestamp("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  hostname: text("hostname"),
  pid: integer("pid"),
});

export type ProcessBootEntity = typeof ProcessBootTable.$inferSelect;

// Notifications — async / scheduled run completions, system messages

/**
 * User-visible notifications. Runner populates on async/scheduled run
 * completion; boot recovery populates on restart for stale runs.
 * No auto-archive — user must explicitly delete.
 */
export const NotificationTable = pgTable(
  "notification",
  {
    // UUIDv7 for SSE Last-Event-ID replay on `/api/runs/stream`.
    id: uuid("id").primaryKey().notNull().default(sql`uuidv7()`),
    /** Owner — only this user sees the row. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    /** Discriminator: "run_completed" | "run_failed" | "system". Drives UI icon/colour/route. */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** Inline preview (~280 chars with ellipsis). */
    body: text("body"),
    /** Full output at notification time (16KB cap). Self-contained, no join needed. */
    fullBody: text("full_body"),
    /** Denormalised source label (survives renames/deletions). Null for system messages. */
    sourceLabel: text("source_label"),
    /** Original task/prompt snapshotted for inbox context. */
    task: text("task"),
    /** Optional FK back to the run that produced the notification. */
    runId: uuid("run_id").references(() => EntityRunTable.id, {
      onDelete: "cascade",
    }),
    /** Denormalised snapshot of `entity_run.initiator` at notification
     *  time. Enables the bell icon to filter out schedule notifications
     *  without JOINing entity_run. Null for legacy rows and system
     *  messages that have no run. */
    initiator: text("initiator"), // "user" | "orchestrator" | "schedule" | "system"
    /** Null = unread; set on the first mark-as-read API call. */
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("notification_owner_idx").on(t.ownerId, t.createdAt),
    index("notification_owner_unread_idx").on(t.ownerId, t.readAt),
  ],
);

export type NotificationEntity = typeof NotificationTable.$inferSelect;
export type NotificationKind = "run_completed" | "run_failed" | "system";

// Schedules — recurring runs (P2.2)

//
// One row per "fire <task> at <cron> on <entity>" rule the user has
// asked Nango to remember. The InProcessScheduler reads enabled rows
// at boot, registers a Croner job per row, and dispatches each tick
// through `runner.start({ mode: "async", initiator: "schedule" })`.
//
// Routing keys are stored as `(entityId, credentialId)` rather than
// the snapshot `sourceLabel` — the label is for display only and is
// allowed to drift if the underlying agent / credential is renamed.
// Hard FK references would block deletes; we use ON DELETE SET NULL
// + a defensive enable-check at trigger time so the scheduler
// degrades gracefully when an agent disappears.
//
// Execution history is NOT denormalised onto this row beyond a few
// "summary" fields (lastTriggeredAt, lastError). The full list of
// runs this schedule produced lives on `entity_run` joined via
// `entity_run.schedule_id`, paginated by the RecentRuns side panel
// in ScheduleEditor.
//
// `lastTriggeredAt` is also the scheduler's anchor for computing the
// NEXT fire of recurring schedules (see `scheduler.ts → nextFireAt`)
// — do not remove it.
//
// `lastError` is null after every successful tick and snapshots the
// last failure reason otherwise; both the SchedulesPanel status icon
// and the supervisor `list_schedules` tool read it directly to avoid
// forcing a join on every read.
//
export const ScheduleTable = pgTable(
  "schedule",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),

    /** Owner — only this user sees / triggers the schedule. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    /** Audit. Usually equal to ownerId; differs only if an admin
     *  ever creates schedules on a user's behalf. */
    createdBy: uuid("created_by")
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),

    /** Routing target. Same vocabulary as EntityRunTable. */
    entityId: text("entity_id").notNull(),
    /** Discriminator for the upstream endpoint family
     *  ("agent" | "team" | "workflow"). Snapshotted at create time
     *  from the catalog entry the user picked, so the scheduler can
     *  fire without a control-plane round-trip and keeps working if
     *  the upstream descriptor is later renamed/relisted. Always
     *  "agent" for built-in entities. */
    entityKind: text("entity_kind").notNull().default("agent"),
    /** Backend credential. Null for built-in agents. SET NULL on
     *  credential delete so an admin removing a credential doesn't
     *  cascade-destroy historical schedule rows; the scheduler will
     *  refuse to fire a schedule whose credential is gone. */
    credentialId: uuid("credential_id").references(() => CredentialTable.id, {
      onDelete: "cascade",
    }),

    /** Display label captured at create time (e.g.
     *  "Built-in / Daily Brief"). Pure UI — the routing keys above
     *  are authoritative. */
    sourceLabel: text("source_label").notNull(),

    /** Optional human-readable name the user set ("Morning standup
     *  digest"). Null = render `${sourceLabel} · ${schedule summary}`. */
    name: text("name"),

    /** The natural-language prompt fed to the entity on each tick. */
    task: text("task").notNull(),

    /**
     * Trigger model — three shapes are valid (validated at the API):
     *
     *   1. one-shot:        startAt only
     *   2. recurring:       startAt + intervalValue + intervalUnit
     *   3. recurring+window:startAt + interval* + endAt
     *
     * `startAt` is the first scheduled fire (also the anchor for
     * computing the next fire on each subsequent tick). `endAt`,
     * when set, makes the schedule auto-disable the moment the next
     * computed fire would fall after it.
     *
     * No cron expression is persisted — the in-process scheduler
     * computes nextFire from these fields directly using a Node.js
     * timer, which lets us express ranges Croner can't (e.g.
     * "every 7 minutes", "every 2 weeks", "every 6 months").
     */
    startAt: timestamp("start_at").notNull(),
    endAt: timestamp("end_at"),
    /** Positive integer multiplier; null for one-shot schedules. */
    intervalValue: integer("interval_value"),
    /** Calendar unit — keeps month / week arithmetic correct
     *  across DST and varying month lengths. */
    intervalUnit: text("interval_unit"), // "minute" | "hour" | "day" | "week" | "month"
    /** IANA timezone (e.g. "America/New_York"). Used for displaying
     *  startAt / endAt in the UI and for month / week arithmetic
     *  that is otherwise ambiguous across DST. Defaults to UTC at
     *  the API layer when the client is timezone-less; the panel
     *  defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
    timezone: text("timezone").notNull().default("UTC"),

    /** Toggle. The scheduler only fires enabled rows; the row stays
     *  in the user's panel either way. */
    enabled: boolean("enabled").notNull().default(true),

    /** Last fire bookkeeping. Read by the SchedulesPanel status icon
     *  ("active" vs "active+last_error" vs "disabled") AND by the
     *  scheduler's nextFireAt anchor — see this table's docblock. */
    lastTriggeredAt: timestamp("last_triggered_at"),
    /** Snapshot of the most recent failure reason — `null` once a
     *  later run succeeds. Avoids forcing the panel / supervisor
     *  list_schedules tool to join entity_run on every read. */
    lastError: text("last_error"),

    createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("schedule_owner_idx").on(t.ownerId),
    index("schedule_enabled_idx").on(t.enabled),
  ],
);

export type ScheduleEntity = typeof ScheduleTable.$inferSelect;
export type ScheduleIntervalUnit =
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month";

// Backend thread state — durable upstream-session tokens per (cred, thread)

/**
 * Per-thread upstream state (e.g. Dify conversation_id). Replaces the old
 * per-process convMap that was lost on Node restart. Namespaced JSONB so
 * multiple providers share one row. Hot-path cached in-memory (LRU);
 * writes are fire-and-forget. Cleanup via periodic sweep on `updated_at`.
 * See docs/backend-integration.md.
 */
export const BackendThreadStateTable = pgTable(
  "backend_thread_state",
  {
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => CredentialTable.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    /** Provider-namespaced JSONB state. @example { "dify": { "convId": "01HQ..." } } */
    state: jsonb("state").notNull(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.credentialId, t.threadId] }),
    // Drives the future TTL sweep: `WHERE updated_at < NOW() - INTERVAL '90 days'`.
    index("backend_thread_state_updated_at_idx").on(t.updatedAt),
  ],
);

export type BackendThreadStateEntity =
  typeof BackendThreadStateTable.$inferSelect;

// Application configuration

export const CONFIG_VALUE_TYPES = ["string", "number", "boolean", "json"] as const;
export type ConfigValueType = (typeof CONFIG_VALUE_TYPES)[number];

export const ConfigTable = pgTable("config", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  valueType: text("value_type").notNull().default("string"),
  options: jsonb("options"),
  prevValue: text("prev_value"),
  description: text("description"),
  updatedBy: uuid("updated_by").references((): AnyPgColumn => UserTable.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type ConfigEntity = typeof ConfigTable.$inferSelect;

// Verification subsystem — deterministic assert-on-output harness for
// MCP tools (V1) and Nango internal workflows (V2). See docs/verification.md
// for the full design. Distinct from the `verification` table above which
// is the better-auth email-verification token store.

/**
 * VerificationSuite — a management group of verification cases.
 * A suite is a pure container; it does NOT bind a specific tool or
 * workflow — the target lives on each case. `category` decides which
 * left-panel tab the suite belongs to and which target columns its
 * cases must populate (enforced by CHECK on `verification_case`).
 *
 * visibility: "private" — visible to the creator only;
 *             "public"  — available to all users.
 */
export const VerificationSuiteTable = pgTable("verification_suite", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  /** Left-panel tab + case target shape. */
  category: text("category").notNull(), // "mcp" | "workflow"
  enabled: boolean("enabled").notNull().default(true),
  visibility: text("visibility").notNull().default("private"),
  /** Suite-level wall-clock cap (seconds) for one `Run suite` invocation.
   *  On expiry the orchestrator marks remaining cases `skipped` and the
   *  run as `timeout`. Stored as seconds to keep the value human-readable
   *  in DB inspectors (300 = 5 min); the runner multiplies by 1000 for
   *  `setTimeout`. */
  timeoutSec: integer("timeout_sec").notNull().default(300),
  createdBy: uuid("created_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  updatedBy: uuid("updated_by").references(() => UserTable.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type VerificationSuiteEntity =
  typeof VerificationSuiteTable.$inferSelect;
export type VerificationSuiteCategory = "mcp" | "workflow";

/**
 * VerificationCase — one assert-on-output case bound to either an MCP
 * tool or a Nango workflow (XOR enforced by CHECK). PK is bigint
 * identity because cases are parent-owned children, never URL-exposed
 * (the suite is). See `AGENTS.md` PK tier 1.
 *
 * Target columns:
 *   - mcp suites:      (mcpServerId, toolName) populated; workflowId NULL
 *   - workflow suites: workflowId populated;       (mcpServerId, toolName) NULL
 *
 * `assertions` is a JSON array of `json_schema` | `jsonpath_equals` |
 * `js_expression` entries. Empty array = smoke test. See
 * docs/verification.md for the wire shape.
 */
export const VerificationCaseTable = pgTable(
  "verification_case",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => VerificationSuiteTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // --- target (XOR by suite.category) ---
    /** Set for MCP cases. CASCADE on server delete — removing an MCP
     *  server removes its verification cases too, keeping the suite
     *  consistent without orphan rows that violate the XOR CHECK. */
    mcpServerId: uuid("mcp_server_id").references(() => McpServerTable.id, {
      onDelete: "cascade",
    }),
    /** Set for MCP cases — matches a tool name in McpServer.tools. */
    toolName: text("tool_name"),
    /** Set for Workflow cases (V2). FK to `workflow.id` deliberately
     *  NOT added in V1: ON DELETE SET NULL would violate the XOR
     *  CHECK below; CASCADE vs RESTRICT is a V2 product call when
     *  the workflow runner lands. V1 never populates this column —
     *  the CHECK forbids it through the suite-category gate. */
    workflowId: uuid("workflow_id"),
    // --- payload ---
    input: jsonb("input").notNull().default(sql`'{}'::jsonb`),
    /** Array of assertion specs. See docs/verification.md. */
    assertions: jsonb("assertions").notNull().default(sql`'[]'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    // Per-suite name uniqueness (mirrors UI assumption).
    uniqueIndex("verification_case_suite_name_idx").on(t.suiteId, t.name),
    // Suite list view ("show all cases in this suite").
    index("verification_case_suite_idx").on(t.suiteId),
    // Reverse-lookup: "which cases test tool X on server Y" — used by
    // the future MCP "Add to verification suite" affordance and by
    // schedule-driven regressions.
    index("verification_case_mcp_tool_idx").on(t.mcpServerId, t.toolName),
    // XOR target: MCP shape OR workflow shape, never both / neither.
    check(
      "verification_case_target_xor",
      sql`(
        (${t.mcpServerId} IS NOT NULL AND ${t.toolName} IS NOT NULL AND ${t.workflowId} IS NULL)
        OR
        (${t.mcpServerId} IS NULL AND ${t.toolName} IS NULL AND ${t.workflowId} IS NOT NULL)
      )`,
    ),
  ],
);

export type VerificationCaseEntity = typeof VerificationCaseTable.$inferSelect;

/**
 * VerificationRun — one execution of a verification suite.
 *
 * UUIDv4 PK because the id is URL-exposed via the history-view
 * `?run=<id>` query param (PK tier 3 in AGENTS.md). UUIDv7 was
 * considered for "time-ordered for free" banner pagination, but the
 * banner is always suite_id-scoped (so it needs a composite index
 * either way), and SSE replay flows through `notification.id`, not
 * through this PK.
 *
 * No case-level payload here — that lives in VerificationCaseResult.
 */
export const VerificationRunTable = pgTable(
  "verification_run",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => VerificationSuiteTable.id, { onDelete: "cascade" }),
    /** Lifecycle: running | passed | failed | errored | timeout.
     *  Precedence on close: timeout > errored > failed > passed. */
    status: text("status").notNull(),
    totalCount: integer("total_count").notNull(),
    passedCount: integer("passed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    erroredCount: integer("errored_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    /** Trigger origin: 'manual' | 'schedule'. */
    triggeredBy: text("triggered_by").notNull(),
    startedAt: timestamp("started_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    // Banner pagination — "5 newest / 5 older" runs of a given suite.
    index("verification_run_suite_started_idx").on(
      t.suiteId,
      t.startedAt.desc(),
    ),
    // Boot-epoch zombie sweep — find still-`running` rows from a prior
    // Node process. Partial index because `status` only has 5 enum
    // values (B-tree selectivity is poor — the planner would usually
    // ignore a plain `status` index). Filtering by `status='running'`
    // shrinks the index to ~ 0 rows in steady state (running rows are
    // ephemeral) and lets recovery's `started_at < bootStartedAt`
    // predicate drive an index range scan.
    //
    // The matching SQL predicate MUST be `status = 'running'`
    // literal-equal for the planner to pick this partial index — see
    // `selectStrandedRuns` / `markStrandedAsErrored` in storage.ts.
    index("verification_run_recovery_idx")
      .on(t.startedAt)
      .where(sql`${t.status} = 'running'`),
  ],
);

export type VerificationRunEntity = typeof VerificationRunTable.$inferSelect;
export type VerificationRunStatus =
  | "running"
  | "passed"
  | "failed"
  | "errored"
  | "timeout";

/**
 * VerificationCaseResult — one case execution within one run. PK is
 * bigint identity (parent-owned, not URL-exposed).
 *
 * `inputSnapshot` is frozen at run time so the user can edit the
 * underlying case freely afterwards without rewriting history. The
 * history view displays the snapshot, not today's case definition.
 *
 * `entityRunId` is non-null ONLY for workflow cases (V2) — those flow
 * through `runner.start({mode:"async", initiator:"verification"})` so
 * admin run forensics works. MCP cases call `mcp/provider-pool`
 * directly (a tool call is not an entity dispatch) and leave it NULL.
 *
 * `error` JSON shape: { source, message, details? } where source ∈
 * { mcphub | upstream | transport | assertion | timeout | internal }.
 * See docs/verification.md.
 */
export const VerificationCaseResultTable = pgTable(
  "verification_case_result",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    runId: uuid("run_id")
      .notNull()
      .references(() => VerificationRunTable.id, { onDelete: "cascade" }),
    caseId: bigint("case_id", { mode: "number" })
      .notNull()
      .references(() => VerificationCaseTable.id, { onDelete: "cascade" }),
    /** passed | failed | errored | skipped | timeout. */
    status: text("status").notNull(),
    /** Workflow cases only. SET NULL keeps the result viewable even
     *  if an admin later prunes the entity_run forest. */
    entityRunId: uuid("entity_run_id").references(() => EntityRunTable.id, {
      onDelete: "cascade",
    }),
    /** Frozen input as it was at run time. */
    inputSnapshot: jsonb("input_snapshot").notNull(),
    /** Tool/workflow output; >8 KB JSON is truncated and the
     *  resultTruncated flag is set. Assertions are always evaluated
     *  against the full payload before truncation. */
    resultPayload: jsonb("result_payload"),
    resultTruncated: boolean("result_truncated").notNull().default(false),
    /** Per-assertion verdicts. See docs/verification.md. */
    assertionResults: jsonb("assertion_results")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Structured failure envelope. NULL for passed cases. See docs/verification.md. */
    error: jsonb("error"),
    durationMs: integer("duration_ms"),
    startedAt: timestamp("started_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    // Drill-down: "all case results in this run" — used by the history-
    // view modal and the run-detail page.
    index("verification_case_result_run_idx").on(t.runId),
    // "Latest status per case" — drives the case-tree status badges.
    // DESC matches the "newest first" lookup. Pairs with the
    // run_idx above; combined the two cover all current queries.
    index("verification_case_result_case_started_idx").on(
      t.caseId,
      t.startedAt.desc(),
    ),
    // Idempotency guard for the boot-epoch recovery sweep. Orchestrator's
    // serial loop never writes the same (run, case) twice on the happy
    // path, but `recoverStrandedVerificationRuns` may re-run if the node
    // crashes mid-recovery — without this constraint a second pass would
    // duplicate the `skipped` filler rows it wrote on the first pass.
    // Pairs with `.onConflictDoNothing()` in `writeSkippedCaseResults`.
    uniqueIndex("verification_case_result_run_case_idx").on(t.runId, t.caseId),
  ],
);

export type VerificationCaseResultEntity =
  typeof VerificationCaseResultTable.$inferSelect;
export type VerificationCaseResultStatus =
  | "passed"
  | "failed"
  | "errored"
  | "skipped"
  | "timeout";
export type VerificationErrorSource =
  /** Process crashed before this case was executed; filler row written
   *  by the boot-epoch recovery sweep. Distinct from "internal" so the
   *  UI can label it as an infrastructure event rather than a bug. */
  | "crashed"
  | "mcphub"
  | "upstream"
  | "transport"
  | "assertion"
  | "timeout"
  | "internal";
