// Has a computed dynamic import whose specifier is a template literal, so it
// cannot be statically resolved to ./computed-<k>. This file is itself an
// orphan too (nothing imports it), demonstrating that a computed import neither
// keeps its (unresolvable) target alive nor keeps this file alive.
export async function loadComputed(k: string): Promise<unknown> {
  return import(`./computed-${k}`);
}
