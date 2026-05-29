// Loaded by entry.ts via a dynamic `import("./lazy")`. The dynamic edge must be
// resolved to this file. It in turn pulls in @config (alias) to show that a
// dynamically-imported module's own imports are also walked.
import { config } from "@config";

export const seed = config.name.length;
