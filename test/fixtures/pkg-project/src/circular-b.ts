// Other half of the cycle (see circular-a.ts).
import { alphaC } from "./circular-a";

export function beta(n: number): number {
  if (n <= 0) return 0;
  return alphaC(n - 1) + 1;
}
