// Unused-export fixture. Some exports are consumed cross-file, some only used
// internally (still unnecessary to export), some never used at all.

// Referenced by consumer.ts -> NOT unused.
export function usedAcrossFile(): number {
  return helperInternal() + 1;
}

// Exported but only ever called within THIS file -> reported as unused export
// (it did not need to be exported).
export function onlyUsedInternally(): number {
  return 42;
}

// Internal (NOT exported) call site for onlyUsedInternally: the symbol is used,
// but only within this file, so its EXPORT is still unnecessary.
function caller(): number {
  return onlyUsedInternally();
}
void caller;

// Never referenced anywhere -> unused.
export const trulyUnused = "dead";

// A plain helper (not exported) — must never appear in the report.
function helperInternal(): number {
  return 1;
}

// Forwarded re-export (declared elsewhere) — must be SKIPPED (not flagged).
export { Role } from "../models";

// Bare star re-export — cannot be name-checked; only surfaces with includeReexports.
export * from "../widget";
