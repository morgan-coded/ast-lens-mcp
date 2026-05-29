// Re-exported by the barrel as a namespace (`export * as utils from "./utils"`).
// On the public surface this appears as a single `namespace utils` symbol; its
// members are not expanded (kept flat).

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// An un-annotated arrow const: exercises the value-shape hint (no type
// inference). Public via the namespace, but only the namespace symbol shows.
export const identity = <T>(x: T): T => x;
