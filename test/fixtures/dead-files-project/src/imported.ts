// Statically imported by index.ts -> reachable, not flagged. Also imports a
// transitive module to prove reachability propagates past direct imports.
// Uses a TS-ESM ".js" specifier that must resolve to ./transitive.ts.
import { deeper } from "./transitive.js";

export function fromImported(): number {
  return deeper();
}
