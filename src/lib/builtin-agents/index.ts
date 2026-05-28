/**
 * Process-wide AgentSpec pool singleton.
 *
 * QUIRK: HMR-survival via globalThis — without this, every `next dev`
 * save would forget every cached AgentSpec and re-hit the DB on the
 * next chat turn. The DB row is source-of-truth so correctness is
 * unaffected, but the latency hit on hot reload is jarring.
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
