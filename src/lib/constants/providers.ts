/**
 * Unified provider registry.
 */

import type { CredentialServiceType } from "@/lib/db/schema";

export interface ProviderEntry {
  /** Slug stored in DB credential.provider column. */
  value: string;
  /** Display label in the UI. */
  label: string;
  /** Service category — auto-fills credential.serviceType. */
  service: CredentialServiceType;
  /** Provider's public default REST base URL. Surfaced in the
   *  credential dialog as the URL input's placeholder so admins
   *  see "you can leave this blank, we'll use this". When the
   *  credential row's `restUrl` is null/empty, runtime code falls
   *  back to this provider's own DEFAULT_BASE_URL constant (the
   *  two must stay in sync — this is a UI hint, not a runtime
   *  source-of-truth). Omitted for providers with no public
   *  default (self-hosted agent platforms, SSH, MCP, data sources). */
  defaultRestUrl?: string;
}

export const PROVIDERS: ProviderEntry[] = [
  // LLM providers
  { value: "openai",    label: "OpenAI",       service: "llm" },
  { value: "anthropic", label: "Anthropic",    service: "llm" },
  { value: "google",    label: "Google AI",    service: "llm" },
  { value: "groq",              label: "Groq",                service: "llm", defaultRestUrl: "https://api.groq.com/openai/v1" },
  { value: "deepseek",          label: "DeepSeek",            service: "llm" },
  { value: "xai",               label: "xAI (Grok)",          service: "llm" },
  { value: "openrouter",        label: "OpenRouter",          service: "llm" },
  { value: "ollama",            label: "Ollama",              service: "llm" },
  { value: "siliconflow",      label: "SiliconFlow",         service: "llm", defaultRestUrl: "https://api.siliconflow.cn/v1" },
  { value: "modelstudio",      label: "ModelStudio",         service: "llm", defaultRestUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { value: "modelscope",       label: "ModelScope",          service: "llm", defaultRestUrl: "https://api-inference.modelscope.cn/v1" },
  { value: "volcengine-ark",   label: "Volcengine Ark",      service: "llm", defaultRestUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  { value: "litellm",          label: "LiteLLM",             service: "llm" },
  { value: "portkey",          label: "Portkey",             service: "llm", defaultRestUrl: "https://api.portkey.ai/v1" },
  // OpenAI-Chat-Completions-compatible endpoints (vLLM, LM Studio, TGI,
  // Together, Fireworks, gateways). Requires `restUrl`. Built-in agents only.
  { value: "openai-compatible", label: "OpenAI-Compatible",   service: "llm" },

  // Agent platforms
  // Backends whose models / apps are *agents* (LLM already bound to
  // tools / KB / workflow upstream). For raw LLM endpoints use the LLM
  // category + a Built-in agent.
  { value: "agno",        label: "Agno",        service: "agent" },
  { value: "mastra",      label: "Mastra",      service: "agent" },
  { value: "dify",        label: "Dify",        service: "agent" },
  { value: "crewai",      label: "CrewAI",      service: "agent" },
  { value: "deepagents",  label: "DeepAgents",  service: "agent" },

  // Search providers
  // The `jina` slot consumes Jina Search (`s.jina.ai`) — a
  // query-driven search API with a generous anonymous-friendly
  // free tier. The Reader endpoint (`r.jina.ai`) is intentionally
  // out of scope: it's a URL → Markdown extractor, not a search,
  // and our `web_search` abstraction is query-driven.
  { value: "exa",       label: "Exa",          service: "search", defaultRestUrl: "https://api.exa.ai" },
  { value: "tavily",    label: "Tavily",       service: "search", defaultRestUrl: "https://api.tavily.com" },
  { value: "brave",     label: "Brave Search", service: "search", defaultRestUrl: "https://api.search.brave.com" },
  { value: "jina",      label: "Jina",         service: "search", defaultRestUrl: "https://s.jina.ai" },

  // Observability providers
  // QUIRK: exactly one enabled `langfuse` credential is consumed at a
  // time. Nango forwards only the traces backend-side Langfuse cannot
  // see (Built-in agents, frontend tools, proxy errors).
  { value: "langfuse",  label: "Langfuse",     service: "observability" },

  // Integration providers (MCP, SSH, …)
  // Agent-callable external systems whose tool surface differs per provider.
  // See docs/ssh.md
  { value: "mcp",       label: "MCP Server",   service: "integration" },
  { value: "ssh",       label: "SSH Server",   service: "integration" },

  // Data sources
  // Specific implementation per credential row; the data-source adapter
  // declares the category ("database" / "object-storage" / "http") in code.
  { value: "postgres",  label: "PostgreSQL",   service: "datasource" },
  { value: "mysql",     label: "MySQL",        service: "datasource" },
  { value: "mariadb",   label: "MariaDB",      service: "datasource" },
  { value: "vertica",   label: "Vertica",      service: "datasource" },

  // Calendar sources
  // ICS subscriptions and calendar API integrations. `restUrl` carries
  // the ICS subscription URL; encrypted payload is typically empty
  // (auth token is embedded in the URL) or carries an API key.
  { value: "ics",              label: "ICS",       service: "calendar" },
  { value: "google",  label: "Google",    service: "calendar" },
  { value: "outlook",          label: "Outlook",   service: "calendar" },
];

/** Lookup map: provider slug → ProviderEntry. */
export const PROVIDER_MAP = new Map(PROVIDERS.map((p) => [p.value, p]));

/** CONTRACT: returns the slug itself when unknown. */
export function getProviderLabel(slug: string | null | undefined): string {
  if (!slug) return "";
  return PROVIDER_MAP.get(slug)?.label ?? slug;
}

/** CONTRACT: returns null for unknown slugs. */
export function getProviderService(slug: string): CredentialServiceType | null {
  return PROVIDER_MAP.get(slug)?.service ?? null;
}

/** Service category labels for display. */
export const SERVICE_LABELS: Record<CredentialServiceType, string> = {
  llm: "LLM",
  agent: "Agent Platform",
  search: "Search",
  observability: "Observability",
  integration: "Integration",
  datasource: "Data Source",
  calendar: "Calendar",
  other: "Other",
};
