// clusterA <-> clusterB import each other but neither is reachable from any
// entry point. Each HAS an importer (the other), so the reason is
// "unreachable-cluster" rather than "no-importers". The scan must terminate on
// the cycle.
import { bThing } from "./clusterB";

export function aThing(): number {
  return bThing() + 1;
}
