// Consumes usedAcrossFile from lib.ts, marking it as used cross-file.
import { usedAcrossFile } from "./lib";

export function run(): number {
  return usedAcrossFile();
}
