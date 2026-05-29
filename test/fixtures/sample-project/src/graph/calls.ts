// Call-graph fixture: intra-file + cross-file calls, anonymous fns, top-level
// calls, an external (library) call, and a recursive call.
import { helper } from "./more";

export function alpha(n: number): number {
  // alpha -> beta (same file) and alpha -> helper (cross file)
  return beta(n) + helper(n);
}

export function beta(n: number): number {
  if (n <= 0) return 0;
  return beta(n - 1) + 1; // recursive self-edge
}

export function usesCallback(items: number[]): number[] {
  // anonymous arrow node; the map call is a member call (external -> unresolved)
  return items.map((x) => beta(x));
}

// Top-level call (from === null): alpha called at module scope.
export const seed = alpha(3);

// External/library call that should NOT resolve to a defined node.
export function fetchThing(): Promise<Response> {
  return fetch("https://example.test");
}
