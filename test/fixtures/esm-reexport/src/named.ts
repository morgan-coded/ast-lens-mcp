// Forwarded by a named re-export (`export { namedPublic } from "./named.js"`).
// A named forward is a reachability root regardless of resolver behavior, so
// this is a control: it must never be flagged.
export function namedPublic(): string {
  return "public";
}
