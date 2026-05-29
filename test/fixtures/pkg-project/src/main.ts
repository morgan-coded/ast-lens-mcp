// The REAL package entry point (declared as dist/main.js in package.json).
// It is NOT named index.*, so only package.json-based entry resolution can
// recognize it as public API. Everything it re-exports is reachable public API
// and must not be flagged as unused.
export { publicThing, PublicType } from "./api";
export * from "./dynamic";

// Imported via a tsconfig path alias (@lib/* -> src/lib/*). Resolving the alias
// is what proves `aliasedHelper` is used cross-file.
import { aliasedHelper } from "@lib/aliased";

// A direct local export from the entry itself: public API root, never flagged.
export function bootstrap(): number {
  return aliasedHelper() + 1;
}
