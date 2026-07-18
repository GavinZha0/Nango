import "server-only";

import { readEvents } from "./event-store";

const GLOBAL_KEY = Symbol.for("nango.runner.sequenceRegistry");

interface RegistryHolder {
  seqs: Map<string, number>;
}

const holder: RegistryHolder = (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { seqs: new Map() };
  }
  return g[GLOBAL_KEY] as RegistryHolder;
})();

export class RunSequenceRegistry {
  public static set(runId: string, seq: number): void {
    holder.seqs.set(runId, seq);
  }

  public static get(runId: string): number | undefined {
    return holder.seqs.get(runId);
  }

  public static async getAndIncrement(runId: string, defaultValue?: number): Promise<number> {
    let current = holder.seqs.get(runId);
    if (current === undefined) {
      if (defaultValue !== undefined) {
        current = defaultValue;
      } else {
        // Fallback: read events from DB
        try {
          const events = await readEvents(runId);
          current = events.length;
        } catch {
          current = 0;
        }
      }
    }
    holder.seqs.set(runId, current + 1);
    return current;
  }

  public static delete(runId: string): void {
    holder.seqs.delete(runId);
  }
}
