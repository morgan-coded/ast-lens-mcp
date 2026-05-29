// Imported by main.ts via the tsconfig path alias `@lib/aliased`.
// Name-based usage detection counts the `aliasedHelper` identifier in main.ts,
// so it is correctly treated as used cross-file even though the import path is
// an alias rather than a relative path.
export function aliasedHelper(): number {
  return 41;
}

// Exported but referenced nowhere -> should be flagged as unused.
export function aliasedDead(): number {
  return 0;
}
