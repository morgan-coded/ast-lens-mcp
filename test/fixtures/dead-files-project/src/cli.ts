// A non-index entry point: package.json "bin" maps "df-cli" -> "./dist/cli.js",
// whose source candidate is src/cli.ts. Only package.json-based root resolution
// recognizes this (it is not an index.* file). It is an entry, so it is never
// flagged even though nothing imports it.
export function run(): void {
  // no-op CLI entry
}
