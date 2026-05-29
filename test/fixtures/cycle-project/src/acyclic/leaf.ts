// Leaf of the acyclic chain. Imports only an external package (a leaf in the
// graph), which must NOT create an edge.
import { readFile } from "node:fs/promises";

export function leaf(): typeof readFile {
  return readFile;
}
