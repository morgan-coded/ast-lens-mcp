// Public barrel — the package entry (declared as dist/index.js in package.json,
// which maps back to this src/index.ts). The PUBLIC API surface is exactly what
// is reachable from here. Anything a sub-module exports but this barrel does NOT
// re-export is internal and must be EXCLUDED from the surface.

// 1. Named re-exports (a function and a const) from ./math.
export { add, PI } from "./math";

// 2. Renamed re-export: `multiply` is exposed publicly as `times`.
export { multiply as times } from "./math";

// 3. Re-export of a class and an interface from ./client.
export { ApiClient } from "./client";
export type { ClientOptions } from "./client";

// 4. Bare star re-export: every public export of ./shapes becomes public API
//    (Shape, Status, makeShape) — but NOT internalShapeHelper, which ./shapes
//    does not export.
export * from "./shapes";

// 5. Namespace re-export of a whole module under one name.
export * as utils from "./utils";

// 6. Re-export from a BARE PACKAGE that is not in scope -> reported unresolved.
export { something } from "external-dep";

// 7. A symbol declared AND exported directly by the entry itself.
export const VERSION: string = "1.0.0";

// 8. A default export (a function declaration).
export default function createPackage(): ApiClient {
  return new ApiClient({ baseUrl: "" });
}

// Local-only import to satisfy the default export's body; NOT an export, so it
// must never appear on the surface.
import { ApiClient } from "./client";
