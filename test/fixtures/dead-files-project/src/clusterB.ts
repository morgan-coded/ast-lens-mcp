// Other half of the unreachable cluster (see clusterA.ts).
import { aThing } from "./clusterA";

export function bThing(): number {
  return aThing() + 1;
}
