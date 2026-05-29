// TS ESM convention: imports carry the OUTPUT ".js" extension but the files on
// disk are ".ts". ea.js <-> eb.js must still resolve to ea.ts / eb.ts and form
// a cycle. This mirrors how ast-lens-mcp's own source imports work.
import { ebValue } from "./eb.js";

export function eaValue(): number {
  return ebValue + 1;
}
