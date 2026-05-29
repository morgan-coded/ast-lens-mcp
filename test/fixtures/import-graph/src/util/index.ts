// Directory entry: entry.ts imports "./util" (no file, no extension), which must
// resolve to this util/index.ts. Also the head of a re-export chain:
//   - `export * from "./strings"` (bare star re-export)
//   - `export { clamp } from "./numbers"` (named re-export)
export * from "./strings";
export { clamp } from "./numbers";
