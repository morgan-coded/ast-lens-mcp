// Self-import: a module that imports from itself (A -> A). A degenerate cycle of
// length 1. (Contrived, but real codebases do occasionally produce these via
// barrel files re-importing their own index.)
import { selfRef } from "./self";

export function selfRef(): number {
  return 1;
}

export function useSelf(): number {
  return selfRef();
}
