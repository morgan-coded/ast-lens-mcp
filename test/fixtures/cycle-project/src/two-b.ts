// Other half of the two-module cycle (see two-a.ts).
import { fromA } from "./two-a";

export function fromB(): number {
  return fromA.length;
}
