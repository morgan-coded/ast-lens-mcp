// Two-module cycle: two-a <-> two-b (extension omitted on the import).
import { fromB } from "./two-b";

export function fromA(): number {
  return fromB() + 1;
}
