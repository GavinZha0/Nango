/**
 * Process-wide AgentSpec pool singleton.
 *
 * QUIRK: pinned to globalThis so HMR (`next dev`) does not drop the
 * cache on every reload. Correctness is unaffected — DB is still
 * source of truth — but latency would jump without this.
 *
 * See docs/builtin-runtime.md.
 */

import "server-only";

import { AgentPool } from "./agent-pool";

declare global {
  var __nangoAgentPool: AgentPool | undefined;
}

export const agentPool: AgentPool = (globalThis.__nangoAgentPool ??=
  new AgentPool());

export { AgentPool } from "./agent-pool";
export type { AgentSpec, AgentToolRef } from "./agent-spec";
