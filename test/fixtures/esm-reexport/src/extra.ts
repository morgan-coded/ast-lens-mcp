// Imported by impl.ts via a `.js` specifier (`import { usedByImpl } from
// "./extra.js"`). This module is NOT star-re-exported by the entry, so it is a
// regular in-graph module — its genuinely-dead export stays flag-eligible,
// proving the `.js`->`.ts` rewrite did not blanket-exclude every `.js` target.
export function usedByImpl(): number {
  return 7;
}

// Exported, re-exported by nothing, referenced nowhere -> genuinely unused.
export function deadInExtra(): void {
  // no-op
}
