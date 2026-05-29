// Circular dependency: circular-a imports from circular-b, and circular-b
// imports from circular-a. The call graph / unused-export scan must terminate
// (no infinite loop) and resolve cross-file names across the cycle.
import { beta } from "./circular-b";

export function alphaC(n: number): number {
  if (n <= 0) return 0;
  return beta(n - 1);
}
