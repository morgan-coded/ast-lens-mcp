// TS-ESM (NodeNext) entry point: it re-exports another module using the
// runtime `.js` extension even though the source file on disk is `impl.ts`.
// find_unused_exports must rewrite "./impl.js" -> "impl.ts" to recognize that
// `impl.ts`'s exports are public API reached through this bare star re-export.
export * from "./impl.js";

// A named re-export using the `.js` convention as well.
export { namedPublic } from "./named.js";
