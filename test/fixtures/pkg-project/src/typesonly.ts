// Type-only export/import edge case. `OnlyAType` is exported as a type and
// consumed type-only by consumer-of-types.ts. A type-only IMPORT specifier is a
// binding (not a usage), but a type ANNOTATION reference to the name does count
// as a usage in the name-based engine — so OnlyAType is used cross-file.
export type OnlyAType = {
  value: string;
};

// An `export type { ... }` block forwarding a locally declared type.
type LocalAlias = number;
export type { LocalAlias };

// A genuinely unused exported type (referenced nowhere).
export type DeadType = boolean;
