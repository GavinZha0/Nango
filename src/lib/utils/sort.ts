// CONTRACT: Standard alphabetical comparison with numeric value support.
// Used consistently by both frontend lists and backend test runners to prevent ordering drift.
export function alphabeticCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}
