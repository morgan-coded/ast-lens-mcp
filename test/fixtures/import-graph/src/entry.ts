// Graph entry point. Exercises every resolution path the import_graph tool
// must handle:
//   - a relative import written with the ESM/NodeNext ".js" extension that maps
//     to a ".ts" source on disk (./helpers.js -> helpers.ts)
//   - a directory/index import (./util -> util/index.ts)
//   - a tsconfig path alias (@lib/math -> src/lib/math.ts)
//   - a bare external import (react) that must be flagged external, not traversed
//   - a dynamic import() with a static specifier (./lazy)
import { add } from "./helpers.js";
import { formatLabel } from "./util";
import { square } from "@lib/math";
import { useState } from "react";

export async function run(): Promise<number> {
  const lazy = await import("./lazy");
  const seed = (lazy as { seed: number }).seed;
  useState(seed);
  return add(square(seed), formatLabel(seed).length);
}
