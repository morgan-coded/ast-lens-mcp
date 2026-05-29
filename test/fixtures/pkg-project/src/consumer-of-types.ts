// Consumes OnlyAType purely as a type annotation, via a type-only import.
// This is the cross-file reference that keeps OnlyAType from being flagged.
import type { OnlyAType } from "./typesonly";

export function describe(x: OnlyAType): string {
  return x.value;
}
