// Resolved from entry.ts through the tsconfig path alias `@lib/*` -> `src/lib/*`,
// i.e. "@lib/math" maps to this file. Proves alias resolution feeds real edges.
export function square(n: number): number {
  return n * n;
}
