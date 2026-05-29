// Acyclic chain: top -> mid -> leaf. No back edges, so no cycle here.
import { mid } from "./mid";

export function top(): number {
  return mid() + 1;
}
