// Referenced ONLY through a string-literal dynamic import in index.ts:
// `await import("./lazy")`. find_dead_files treats a statically-analyzable
// (string-literal) dynamic import as a real edge, so this file is reachable and
// NOT flagged (its importer shows up via a dynamic edge).
export function lazyValue(): number {
  return 4;
}
