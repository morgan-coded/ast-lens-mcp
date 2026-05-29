// Aliased cycle: x imports y via a tsconfig path alias ("@alias/y"), and y
// imports x back via a relative path. The cycle is only detected when tsconfig
// `paths` resolution is on (useTsconfigPaths=true); with it off, x's edge to y
// does not resolve and the pair is acyclic.
import { yThing } from "@alias/y";

export function xThing(): number {
  return yThing() + 1;
}
