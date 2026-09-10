// Pure utility for computing case prefix in suites.
// Zero dependencies to allow safe import in Client Components without pulling "server-only" modules.

/**
 * Computes the next 3-digit case prefix step (step of 10) based on existing cases in the suite.
 * Starts at "010_" if no numbered cases exist.
 */
export function computeNextCasePrefix(existingCases: Array<{ name: string }>): string {
  let maxNum = 0;
  let foundAny = false;
  for (const c of existingCases) {
    const m = c.name.trim().match(/^(\d+)/);
    if (m) {
      foundAny = true;
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  if (!foundAny) return "010_";
  const nextNum = Math.floor(maxNum / 10) * 10 + 10;
  return `${String(nextNum).padStart(3, "0")}_`;
}
