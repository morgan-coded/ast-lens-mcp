// Dynamic-import cycle: da statically imports db, and db reaches back to da only
// through a dynamic import(). With includeDynamic=true this is a cycle; with
// includeDynamic=false, db's edge disappears and the pair is acyclic. This is
// the canonical "dynamic import deliberately breaks a runtime cycle" case.
import { dbValue } from "./db";

export function daValue(): number {
  return dbValue;
}
