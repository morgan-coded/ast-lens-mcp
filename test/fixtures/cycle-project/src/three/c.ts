// Closes the 3-cycle back to a. Also re-exports a's symbol via `export ... from`
// to prove re-export sources count as edges too.
import { aThing } from "./a";
export { aThing as aThingReexported } from "./a";

export function cThing(): number {
  return aThing();
}
