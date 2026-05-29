// Imported only by imported.ts, which is itself reachable from the entry.
// Transitively reachable -> not flagged.
export function deeper(): number {
  return 1;
}
