// Symbols re-exported by the entry (main.ts) via `export { publicThing, PublicType } from "./api"`.
// They are reachable public API through the package entry, so find_unused_exports
// must NOT flag them even though api.ts is not itself an entry point.

export function publicThing(): string {
  return "public";
}

export type PublicType = { id: number };

// Exported here, never referenced anywhere (not re-exported by the entry,
// not imported). This SHOULD be flagged as unused.
export function orphanInApi(): void {
  // no-op
}
