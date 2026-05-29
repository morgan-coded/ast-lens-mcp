// Three-module cycle: three/a -> three/b -> three/c -> three/a.
// Imports the directory (resolves via three/index.ts) to also exercise barrel
// + index resolution, but the actual edge target is three/b.
import { bThing } from "./b";

export function aThing(): number {
  return bThing() + 1;
}
