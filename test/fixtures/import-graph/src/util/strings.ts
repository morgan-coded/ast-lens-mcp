// Re-exported wholesale by util/index.ts via `export * from "./strings"`.
// formatLabel is the symbol entry.ts ultimately consumes through the barrel.
export function formatLabel(n: number): string {
  return `#${n}`;
}
