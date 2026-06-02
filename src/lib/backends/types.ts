/**
 * Backend platform abstraction — domain types and adapter interface.
 *
 * See docs/backend-integration.md.
 */

/** CONTRACT: adapters never throw; they return `{ data }` or `{ error }`. */
export type FetchResult<T> =
  | { data: T; error: null }
  | { data: null; error: string };

// Provider registry

/** Single source of truth for BackendId. Both registries `satisfy Record<BackendId, X>`. */
export const BACKEND_IDS = ["agno", "mastra", "dify"] as const;

export type BackendId = (typeof BACKEND_IDS)[number];

const PROVIDER_ID_SET: ReadonlySet<string> = new Set(BACKEND_IDS);

/**
 * CONTRACT: type guard for untrusted strings (DB rows, request
 * headers). Lives in `types.ts` (isomorphic) so server and client
 * share one implementation without crossing the server-only boundary.
 */
export function isSupportedBackend(
  value: string | null | undefined,
): value is BackendId {
  return value != null && PROVIDER_ID_SET.has(value);
}

// Domain descriptors

/** Canonical model summary projected from each backend's native shape. */
export interface ModelInfo {
  /** Model identifier ("gpt-4o", "claude-3.5-sonnet", …). */
  id: string;
  /** Distinct human label, only when the provider exposes one separate
   *  from the id. */
  displayName?: string;
  /** Model provider slug, e.g. "openai", "anthropic". */
  provider?: string;
}

/** Discriminator for backend entities. Drives upstream endpoint
 *  routing (`/agents/...` vs `/teams/...` vs `/workflows/...`). */
export type EntityKind = "agent" | "team" | "workflow";

export const ALL_ENTITY_KINDS: readonly EntityKind[] = [
  "agent",
  "team",
  "workflow",
] as const;

/**
 * Canonical entity descriptor returned by every adapter. Discriminated
 * by `kind`; counts (`toolCount`, `skillCount`, `kbCount`) instead of
 * full lists because the agent-list view only renders numbers.
 */
export interface EntityDescriptor {
  id: string;
  kind: EntityKind;
  name?: string;
  description?: string;
  /** Full system prompt / instructions; not shown in the list view. */
  prompt?: string;
  /**
   * Optional version label surfaced in the agent list (string so
   * semver-style values fit without a schema migration). Maps to
   * A2A `AgentCard.version` when we expose an Agent Card endpoint —
   * see docs/a2a-compatibility.md.
   */
  version?: string;

  provider: BackendId;
  credentialId: string;
  /** Display label of the credential. Set by the façade. */
  credentialName?: string;

  model?: ModelInfo;
  toolCount?: number;
  skillCount?: number;
  kbCount?: number;
  /** Members count — populated when `kind === "team"`. */
  memberCount?: number;

  /** Opaque per-entity handle for some backends. See docs/backend-integration.md. */
  dbId?: string;

  /** Backend-specific raw fields. Adapter-internal — UI must not read it. */
  raw?: Record<string, unknown>;
}

/** Conversation-thread descriptor. Shape mirrors agno's wire format
 *  (HistoryPanel was built around it); other adapters project onto it. */
export interface SessionDescriptor {
  session_id: string;
  session_name: string;
  created_at: string;
  updated_at?: string;
}

/** Stable cross-list identity key for an agent. */
export function agentKey(credentialId: string | undefined, id: string): string {
  return `${credentialId ?? ""}::${id}`;
}

// Capabilities

/** Static capability flags advertised by an adapter. UI / orchestrator
 *  consult these to branch with conditional rendering instead of
 *  letting adapters return empty payloads. */
export interface BackendCapabilities {
  /** Human-readable platform name for the UI. */
  readonly displayName: string;
  /** Which entity kinds `listEntities` may produce. */
  readonly entityKinds: readonly EntityKind[];
}

// Adapter interface

/**
 * Client-safe adapter for health probes and capability advertisement.
 * Server-only chat + entity-discovery surfaces live on `BackendModule`
 * below.
 *
 * CONTRACT: implementations are stateless, never throw, and tag
 * descriptors with `credentialId` + `provider`.
 */
export interface IBackendAdapter {
  readonly provider: BackendId;
  readonly capabilities: BackendCapabilities;
}

// Chat handler (server-only)

/** Context passed to a chat handler. Resolved from the request URL,
 *  the `X-Credential-Id` header, and server-side state. */
export interface ChatContext {
  /** Credential row id from `X-Credential-Id` header. The single
   *  client-supplied identity field on the chat route. */
  credentialId: string;
  /** Entity id parsed from the URL path
   *  (`/agent/<id>/<run|connect|stop>`); not from any header. */
  agentId: string;
  /**
   * Server-derived from `EntityCatalog.list(credentialId)` — looked up
   * once per dispatch. Programmatic callers (`runner.start`) resolve
   * it via the supervisor catalog or `schedule.entity_kind`. The
   * client never supplies this.
   */
  agentKind: EntityKind;
  /** Authenticated user id (stable UUID), forwarded as `user_id`. */
  userId: string;
  /** CopilotKit endpoint base path, e.g. "/api/copilotkit". */
  endpoint: string;
  /**
   * Optional CopilotKit AgentRunner override — the runner layer
   * constructs a `PersistedAgentRunner` per request for `/run` and
   * `/connect` paths so DB-backed persistence + history replay
   * applies uniformly across backend agents and built-in agents.
   * Unset for `/info` and `/threads/*` bookkeeping fast paths.
   */
  runner?: import("@/lib/copilot/index.server").AgentRunner;
}

/**
 * Server-only contract for turning a chat dispatch into an
 * `AbstractAgent`. The Runner injects a `PersistedAgentRunner` into
 * the CopilotRuntime that drives the returned agent, so handlers
 * stay focused on protocol bridging.
 *
 * CONTRACT: `buildAgent` may return a `Response` directly on
 * credential errors (404 / 503); the Runner short-circuits without
 * creating a run row in that case.
 */
export interface IBackendChatHandler {
  readonly provider: BackendId;
  buildAgent(ctx: ChatContext): Promise<import("@/lib/copilot/index.server").AbstractAgent | Response>;
}

/** Server-only entity-discovery fetcher used by `EntityCatalog`. */
export type EntityFetcher = (
  credId: string,
  restUrl: string,
  token: string,
) => Promise<EntityDescriptor[]>;

/**
 * Single-entry provider registration. Aggregates capabilities,
 * control-plane (REST adapter + entity fetcher), and data-plane
 * (chat handler) per platform.
 */
export interface BackendModule {
  readonly id: BackendId;
  readonly capabilities: BackendCapabilities;
  readonly controlPlane: {
    /** Client-safe REST helpers proxied via `/api/backend`. */
    readonly adapter: IBackendAdapter;
    /** Server-only entity discovery for `EntityCatalog`. */
    readonly fetchEntities: EntityFetcher;
  };
  readonly dataPlane: {
    readonly chatHandler: IBackendChatHandler;
  };
}
