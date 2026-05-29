// Standalone module (not reached from entry.ts) used to exercise:
//   - an UNRESOLVED relative import: "./does-not-exist" resolves to no in-graph
//     file and must be reported as unresolved (not external, not a node).
//   - a deep external import (node: builtin) flagged external, not traversed.
import { missing } from "./does-not-exist";
import { readFile } from "node:fs/promises";

export function orphan(): unknown {
  return [missing, readFile];
}
