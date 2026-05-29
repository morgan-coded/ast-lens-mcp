// A mix of functions and a const. `add`, `multiply`, and `PI` are forwarded by
// the barrel (public). `subtract` is exported here but NOT re-exported by the
// barrel, so it is INTERNAL and must be excluded from the public surface.

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

// Exported locally but never re-exported from the entry -> internal, excluded.
export function subtract(a: number, b: number): number {
  return a - b;
}

export const PI: number = 3.14159;

// A non-exported helper -> never on any surface.
function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
