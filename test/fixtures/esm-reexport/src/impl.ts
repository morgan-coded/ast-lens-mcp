// Reached only via `export * from "./impl.js"` in index.ts. Under the old
// resolver the `.js` specifier failed to map to this `.ts` file, so these were
// wrongly flagged as unused. With the JS->TS rewrite they are public API.
import { usedByImpl } from "./extra.js";

export function publicViaStar(): number {
  return usedByImpl();
}

export const PUBLIC_VALUE = 42;
