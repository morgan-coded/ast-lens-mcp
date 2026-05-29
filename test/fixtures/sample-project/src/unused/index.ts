// Entry point for the unused-export fixture. Its OWN exports must not be flagged
// (default entryPoints includes "**/index.*"). `entryOnlyExport` is exported
// here and never used elsewhere, yet must be excluded as public API surface.
export { run } from "./consumer";

export function entryOnlyExport(): string {
  return "public-api";
}
