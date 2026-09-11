/**
 * Test-data naming helpers. Every E2E-created resource gets a unique,
 * collision-free name so parallel workers and repeated runs never clash.
 * `fullyParallel` runs specs in separate processes, so a time-only suffix is
 * not enough — we mix time, a random segment, and an in-process sequence.
 */

let seq = 0;

/** Short, unique suffix (e.g. `kx1f2b3c-a7c9-1`). */
export function uniqueSuffix(): string {
  seq += 1;
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${time}-${rand}-${seq}`;
}

/** Canonical name for a test-created resource: `<prefix>-e2e-<suffix>`. */
export function uniqueName(prefix: string): string {
  return `${prefix}-e2e-${uniqueSuffix()}`;
}