/**
 * Default configuration values — single source of truth.
 *
 * Each entry defines a config key's code default, type, and
 * human-readable description. The seed function uses this to populate
 * the `config` table on first boot; the config service falls back to
 * these defaults when a key is missing from the DB.
 */

import type { ConfigValueType } from "@/lib/db/schema";

export interface ConfigDefault {
  key: string;
  value: string;
  valueType: ConfigValueType;
  description: string;
  /** Allowed values for enum-type configs. NULL = free input. */
  options?: string[];
}

export const CONFIG_DEFAULTS: readonly ConfigDefault[] = [
  // ── sandbox ───────────────────────────────────────────────────────
  { key: "sandbox.timeout", value: "30", valueType: "number", description: "Execution timeout in seconds" },
  { key: "sandbox.memory_mb", value: "256", valueType: "number", description: "Container memory limit in MB" },
  { key: "sandbox.cpu_cores", value: "0.8", valueType: "number", description: "CPU limit as fractional cores" },
  { key: "sandbox.tmpfs_size_mb", value: "512", valueType: "number", description: "Tmpfs size in MB" },
  { key: "sandbox.stdout_max_chars", value: "20000", valueType: "number", description: "Max stdout chars before truncation" },
  { key: "sandbox.stderr_max_chars", value: "10000", valueType: "number", description: "Max stderr chars before truncation" },

  // ── cache ─────────────────────────────────────────────────────────
  { key: "cache.agent_pool.ttl", value: "600", valueType: "number", description: "Agent pool TTL in seconds" },
  { key: "cache.agent_pool.max", value: "500", valueType: "number", description: "Max cached agent specs" },
  { key: "cache.skill_pool.ttl", value: "600", valueType: "number", description: "Skill pool TTL in seconds" },
  { key: "cache.skill_pool.max", value: "500", valueType: "number", description: "Max cached skill specs" },
  { key: "cache.mcp_pool.idle_timeout", value: "300", valueType: "number", description: "MCP idle timeout in seconds" },
  { key: "cache.mcp_pool.reaper_interval", value: "60", valueType: "number", description: "MCP reaper poll interval in seconds" },
  { key: "cache.credential.ttl", value: "600", valueType: "number", description: "Credential lookup TTL in seconds" },
  { key: "cache.entity_catalog.ttl", value: "600", valueType: "number", description: "Entity catalog TTL in seconds" },
  { key: "cache.entity_catalog.max", value: "100", valueType: "number", description: "Max cached entity lists" },
  { key: "cache.thread_state.max", value: "5000", valueType: "number", description: "Max cached thread states" },

  // ── datasource ────────────────────────────────────────────────────
  { key: "datasource.extract.timeout", value: "60", valueType: "number", description: "Extract timeout in seconds" },
  { key: "datasource.extract.max_rows", value: "1000000", valueType: "number", description: "Max rows per extract" },
  { key: "datasource.extract.ttl_hours", value: "24", valueType: "number", description: "Cache lifetime in hours" },
  { key: "datasource.preview.max_rows", value: "200", valueType: "number", description: "Preview row hard cap" },
  { key: "datasource.preview.max_bytes", value: "50000", valueType: "number", description: "Preview byte hard cap" },
  { key: "datasource.preview.default_rows", value: "5", valueType: "number", description: "Default preview rows" },

  // ── sql node inline-vs-cached policy ──────────────────────────────
  // Workflow SQL node decides between INLINE mode (full result
  // carried in `rows`) and CACHED mode (top-N preview + parquet
  // handle). Bounded by `datasource.preview.max_rows` upstream
  // because the SQL tool currently materialises previews through
  // the same path.
  { key: "sql.inline_max_rows", value: "200", valueType: "number", description: "Row count cap below which a workflow SQL node returns the full result inline (returned_rows == total_rows). Above this, only the top-N preview is carried in `rows` and downstream nodes must read the parquet handle via `dataset_name`." },
  { key: "sql.inline_max_bytes_mb", value: "20", valueType: "number", description: "Byte cap (MB) alongside `sql.inline_max_rows`. Reserved for future bytes-aware truncation; not yet enforced." },

  // ── ssh ────────────────────────────────────────────────────────────
  { key: "ssh.exec_timeout", value: "30", valueType: "number", description: "Command timeout in seconds" },
  { key: "ssh.connect_timeout", value: "10", valueType: "number", description: "Connection timeout in seconds" },
  { key: "ssh.max_output_bytes", value: "1048576", valueType: "number", description: "Max output per stream in bytes (1 MiB)" },

  // ── skill ─────────────────────────────────────────────────────────
  { key: "skill.max_file_bytes", value: "262144", valueType: "number", description: "Max single file size in bytes (256 KB)" },
  { key: "skill.max_files", value: "100", valueType: "number", description: "Max files per skill" },
  { key: "skill.max_total_bytes", value: "10485760", valueType: "number", description: "Max total size per skill in bytes (10 MB)" },

  // ── auth ──────────────────────────────────────────────────────────
  { key: "auth.session_expiry", value: "604800", valueType: "number", description: "Session lifetime in seconds (7 days)" },
  { key: "auth.session_refresh", value: "86400", valueType: "number", description: "Session refresh interval in seconds (1 day)" },

  // ── mcp ───────────────────────────────────────────────────────────
  { key: "mcp.discovery_timeout", value: "5", valueType: "number", description: "Tool discovery timeout in seconds" },

  // ── infrastructure ────────────────────────────────────────────────
  { key: "sandbox.mode", value: "subprocess", valueType: "string", description: "Sandbox backend", options: ["subprocess", "local-docker", "remote-docker"] },
  { key: "sandbox.runtime", value: "docker", valueType: "string", description: "Container runtime", options: ["docker", "podman"] },
  { key: "sandbox.image", value: "sandbox-runner:latest", valueType: "string", description: "Container image for local-docker backend" },
  { key: "sandbox.subprocess.python_path", value: "", valueType: "string", description: "Absolute path to a Python interpreter or venv root (subprocess backend only). Examples: ~/.pyenv/versions/nango (pyenv-virtualenv), ~/miniforge3/envs/myenv (conda), ~/projects/x/.venv (plain venv). Empty = system python3 from PATH." },
  { key: "datasource.cache_root", value: "", valueType: "string", description: "Parquet cache root path (empty = <repoRoot>/.cache/datasource — under the project root for easy inspection / cleanup)" },

  // ── supervisor ──────────────────────────────────────────────────
  { key: "supervisor.catalog_excerpt_chars", value: "300", valueType: "number", description: "Max characters of each specialist's system prompt shown in the supervisor catalog (the 'about' field). Longer prompts are truncated with an ellipsis." },

  // ── runner ──────────────────────────────────────────────────────
  { key: "runner.sync_timeout", value: "300", valueType: "number", description: "Sync (delegate_to_agent) run timeout in seconds" },
  { key: "runner.async_timeout", value: "1800", valueType: "number", description: "Async (delegate_async / schedule) run timeout in seconds" },

  // ── observability ─────────────────────────────────────────────────
  { key: "observability.langfuse.targets", value: "builtin,frontend,proxy_errors", valueType: "string", description: "Comma-separated Langfuse trace targets: builtin, frontend, proxy_errors" },

  // ── evaluation ──────────────────────────────────────────────────
  { key: "eval.threshold.excellent", value: "80", valueType: "number", description: "Score >= this is 'Excellent' (0-100)" },
  { key: "eval.threshold.pass", value: "60", valueType: "number", description: "Score >= this is 'Pass' (0-100)" },
  { key: "eval.threshold.poor", value: "40", valueType: "number", description: "Score >= this is 'Poor'; below is 'Fail' (0-100)" },
] as const;

/** Lookup map for fast default resolution. */
export const CONFIG_DEFAULTS_MAP: ReadonlyMap<string, ConfigDefault> = new Map(
  CONFIG_DEFAULTS.map((d) => [d.key, d]),
);
