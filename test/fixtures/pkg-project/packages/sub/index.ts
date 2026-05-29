// Entry of a nested sub-package (multi-package layout). This file matches the
// default "**/index.*" entry-point glob, so its own exports are public API.
import { subInternal } from "./internal";

export function subPublic(): number {
  return subInternal() * 2;
}
