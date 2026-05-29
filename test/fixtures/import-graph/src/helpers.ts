// Imported by entry.ts via a relative specifier with no extension ("./helpers").
// Resolution must add the ".ts" extension to reach this file.
export function add(a: number, b: number): number {
  return a + b;
}

// Exported but imported by no one in the graph — a candidate dead export the
// downstream unused-export analysis can flag (documented follow-up).
export function unusedHelper(): void {}
