// Entry point. Matches the default "**/index.*" glob AND is the source mapping
// of package.json "main": "./dist/index.js". Everything it (transitively)
// imports is reachable and must NOT be reported dead.
import { fromImported } from "./imported";
import { aliasedUsed } from "@util/aliasedUsed";

export async function main(): Promise<number> {
  // String-literal dynamic import: treated as a real edge, so ./lazy is reachable.
  const lazy = await import("./lazy");
  return fromImported() + aliasedUsed() + (lazy as { lazyValue: () => number }).lazyValue();
}
