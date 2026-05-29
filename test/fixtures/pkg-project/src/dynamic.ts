// Re-exported by the entry via `export * from "./dynamic"` (a bare star
// re-export from a public entry point). Uses a dynamic import() so we exercise
// dynamic-dependency handling. `lazyLoad` is public API via the star re-export.
export async function lazyLoad(name: string): Promise<unknown> {
  // Dynamic import with a computed specifier: the dep is non-literal and cannot
  // be statically resolved, which must not crash the scan.
  const mod = await import(`./circular-${name}`);
  return mod;
}

// A statically-specified dynamic import as well.
export async function loadApi(): Promise<unknown> {
  return import("./api");
}
