// Used only by the sub-package's own index.ts. Because index.ts (an entry point)
// references it cross-file, subInternal is NOT flagged unused (it has a real
// cross-file use), even though it is "internal" to the sub-package.
export function subInternal(): number {
  return 7;
}

// Exported, referenced by no other file -> flagged unused.
export function subOrphan(): void {}
