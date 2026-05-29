/**
 * Module import-graph construction + cycle detection.
 *
 * Self-contained helper for the detect_circular_deps tool. It turns a batch of
 * parsed modules into a directed import graph (edge A -> B when module A imports
 * module B), resolving relative specifiers, index files, omitted extensions, and
 * — best-effort — tsconfig `paths` aliases, while treating bare/external
 * specifiers (node_modules, node: builtins) as leaves that produce no edge. It
 * then enumerates the elementary cycles in that graph.
 *
 * Resolution is purely path-based against the set of files already in scope (no
 * extra filesystem reads beyond a one-time tsconfig load), mirroring
 * core/entryPoints.ts#resolveRelativeSpecifier and the import-walking style used
 * by find_unused_exports / summarize_module.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { File } from "@babel/types";
import { summarizeModule } from "./extract.js";

/** Extensions tried (in order) when a specifier omits one or targets a dir/index. */
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Map a JS-family extension to the TS-family source extensions a `./x.js`
 * specifier may actually refer to under TypeScript's ESM convention (where the
 * import path keeps the OUTPUT extension but the file on disk is `.ts`/`.tsx`).
 * Keyed by the literal extension as written in the specifier.
 */
const JS_TO_TS_EXTS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"]
};

/** A directed import edge in the module graph. */
export interface ModuleEdge {
  /** Importing module (display path, forward slashes, root-relative). */
  from: string;
  /** Imported module (display path) — always an in-scope, resolved file. */
  to: string;
  /** The specifier text as written (e.g. "./b", "@lib/x"). */
  specifier: string;
}

/** The constructed import graph plus diagnostics about edges that did not resolve. */
export interface ModuleGraph {
  /** All in-scope module display paths (graph nodes), sorted. */
  nodes: string[];
  /** Resolved intra-scope edges. */
  edges: ModuleEdge[];
  /** Adjacency: node -> sorted unique list of in-scope modules it imports. */
  adjacency: Map<string, string[]>;
  /**
   * Specifiers that look local (relative / alias) but did not resolve to an
   * in-scope file — useful as a caveat (out-of-scope target, missing file, or an
   * alias the resolver could not map). External/bare specifiers are NOT counted
   * here; they are expected leaves.
   */
  unresolvedLocal: Array<{ from: string; specifier: string }>;
}

/** A single tsconfig `paths` alias compiled to a matcher. */
interface AliasRule {
  /** Literal prefix before the wildcard, e.g. "@lib/" (empty for exact, no `*`). */
  prefix: string;
  /** Literal suffix after the wildcard (usually ""). */
  suffix: string;
  /** Whether the pattern contained a `*`. */
  wildcard: boolean;
  /**
   * Replacement targets exactly as declared (relative to baseUrl), with any `*`
   * preserved as a literal token. Substituted and resolved against baseDirAbs at
   * lookup time — done lazily so a trailing-slash directory segment (e.g.
   * "src/lib/*") survives, which path.resolve would otherwise normalize away.
   */
  targets: string[];
}

/** Compiled tsconfig path-mapping configuration. */
export interface PathAliasConfig {
  /** baseUrl resolved to a root-relative posix dir ("" = project root). */
  baseUrl: string;
  /** Absolute baseUrl directory; targets resolve against this. Empty when none. */
  baseDirAbs: string;
  /** Absolute project root; used to make resolved targets root-relative. */
  root: string;
  rules: AliasRule[];
}

/** Strip `// line` and `/* block *​/` comments from JSONC (tsconfig allows them). */
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Preserve the escaped char verbatim.
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** An empty (no-op) path-alias config. */
export function emptyAliasConfig(root = ""): PathAliasConfig {
  return { baseUrl: "", baseDirAbs: "", root, rules: [] };
}

/**
 * Load and compile `<root>/tsconfig.json` path mappings (baseUrl + paths),
 * best-effort. Never throws: a missing/malformed/extends-only tsconfig yields no
 * rules. `extends` is intentionally NOT followed (kept simple and dependency-
 * free); aliases declared only in a base config simply don't resolve and surface
 * as unresolved-local caveats.
 */
export async function loadPathAliases(root: string): Promise<PathAliasConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, "tsconfig.json"), "utf8");
  } catch {
    return emptyAliasConfig(root);
  }
  let json: { compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  try {
    json = JSON.parse(stripJsonComments(raw)) as typeof json;
  } catch {
    return emptyAliasConfig(root);
  }
  const co = json.compilerOptions;
  if (!co || typeof co !== "object") return emptyAliasConfig(root);

  const baseUrlRaw = typeof co.baseUrl === "string" ? co.baseUrl : ".";
  // baseUrl is resolved relative to the tsconfig's directory (the root here).
  const baseDirAbs = path.resolve(root, baseUrlRaw);
  const baseUrl = path.relative(root, baseDirAbs).split(path.sep).join("/");

  const rules: AliasRule[] = [];
  const paths = co.paths;
  if (paths && typeof paths === "object") {
    for (const [pattern, value] of Object.entries(paths as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      // Targets kept verbatim (relative to baseUrl, `*` preserved); resolved at
      // lookup time so trailing-slash directory segments survive.
      const targets = value.filter((v): v is string => typeof v === "string");
      if (targets.length === 0) continue;
      const starIdx = pattern.indexOf("*");
      const wildcard = starIdx !== -1;
      const prefix = wildcard ? pattern.slice(0, starIdx) : pattern;
      const suffix = wildcard ? pattern.slice(starIdx + 1) : "";
      rules.push({ prefix, suffix, wildcard, targets });
    }
  }
  return { baseUrl, baseDirAbs, root, rules };
}

/** True for a relative specifier (`./x`, `../y`). */
function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * Resolve a possibly-aliased / relative module specifier referenced FROM a file
 * to a concrete in-scope display path, or undefined when nothing in scope
 * satisfies it. Tries, in order: the exact path; if the path carries a JS-family
 * extension, the TS-family source equivalents (TypeScript's `./x.js`-means-`.ts`
 * ESM convention); the path + each supported extension; then
 * `<path>/index.<ext>`. Pure (operates on the `known` set).
 */
function resolveCandidatePath(joined: string, known: Set<string>): string | undefined {
  const normalized = path.posix.normalize(joined);

  // Exact match (path already includes an in-scope extension).
  if (known.has(normalized)) return normalized;

  // TS ESM convention: a specifier ending in a JS-family extension typically
  // refers to a `.ts`/`.tsx` source. Try the body with each TS equivalent.
  const ext = path.posix.extname(normalized);
  const tsEquivalents = JS_TO_TS_EXTS[ext];
  if (tsEquivalents) {
    const body = normalized.slice(0, normalized.length - ext.length);
    for (const e of tsEquivalents) {
      if (known.has(`${body}${e}`)) return `${body}${e}`;
    }
  }

  // Extensionless specifier: append each supported extension.
  for (const e of RESOLVE_EXTS) {
    if (known.has(`${normalized}${e}`)) return `${normalized}${e}`;
  }

  // Directory specifier: resolve to its index.* barrel.
  for (const e of RESOLVE_EXTS) {
    if (known.has(`${normalized}/index${e}`)) return `${normalized}/index${e}`;
  }
  return undefined;
}

/**
 * Resolve one import specifier to an in-scope module display path.
 *
 * Order: relative specifiers resolve against the importer's directory; otherwise
 * tsconfig `paths` aliases are tried (longest, most-specific prefix first);
 * everything else (bare packages, `node:` builtins, unmatched) is treated as an
 * external leaf and returns undefined.
 *
 * Returns `{ to }` when resolved in scope, `{ local: true }` when it looked
 * local (relative or alias-matched) but did not resolve to an in-scope file, or
 * `null` for an external/bare specifier.
 */
export function resolveSpecifier(
  fromDisplay: string,
  spec: string,
  known: Set<string>,
  aliases: PathAliasConfig
): { to: string } | { local: true } | null {
  if (isRelative(spec)) {
    const fromDir = path.posix.dirname(fromDisplay.replace(/\\/g, "/"));
    const joined = path.posix.join(fromDir, spec);
    const to = resolveCandidatePath(joined, known);
    return to ? { to } : { local: true };
  }

  // Absolute path specifier (rare in source) — resolve as-is relative to root.
  if (spec.startsWith("/")) {
    const to = resolveCandidatePath(spec.replace(/^\/+/, ""), known);
    return to ? { to } : { local: true };
  }

  // tsconfig path-alias resolution. Prefer the most specific (longest-prefix)
  // matching rule, as the TS resolver does.
  const matching = aliases.rules
    .filter((r) => matchesAlias(r, spec))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const rule of matching) {
    const star = rule.wildcard ? spec.slice(rule.prefix.length, spec.length - rule.suffix.length) : "";
    for (const target of rule.targets) {
      const substituted = target.includes("*") ? target.replace("*", star) : target;
      // Resolve against baseUrl, then back to a root-relative posix path. Done
      // here (not at load time) so a trailing-slash dir token survives.
      const abs = path.resolve(aliases.baseDirAbs || aliases.root, substituted);
      const rootRel = path.relative(aliases.root, abs).split(path.sep).join("/");
      const to = resolveCandidatePath(rootRel, known);
      if (to) return { to };
    }
    // Matched an alias pattern but no target file is in scope.
    return { local: true };
  }

  // Bare package / node: builtin / unmatched bare specifier => external leaf.
  return null;
}

/** Whether a specifier matches an alias rule's pattern. */
function matchesAlias(rule: AliasRule, spec: string): boolean {
  if (!rule.wildcard) return spec === rule.prefix;
  return (
    spec.length >= rule.prefix.length + rule.suffix.length &&
    spec.startsWith(rule.prefix) &&
    spec.endsWith(rule.suffix)
  );
}

export interface BuildGraphInput {
  /** Parsed modules in scope: their AST + display path (root-relative posix). */
  modules: Array<{ ast: File; display: string }>;
  /** Compiled tsconfig path aliases (pass an empty config to disable). */
  aliases: PathAliasConfig;
  /** When false, dynamic import()/require() specifiers do not create edges. */
  includeDynamic: boolean;
  /** When false, type-only imports/exports do not create edges. */
  includeTypeOnly: boolean;
}

/**
 * Build the directed import graph among the in-scope modules.
 *
 * Edges come from each module's dependency specifiers (static imports,
 * re-exports, and — unless disabled — dynamic import()/require()), resolved to
 * other in-scope modules. A module importing itself yields a self-edge (A -> A).
 * Multiple imports of the same target collapse to a single edge.
 */
export function buildModuleGraph(input: BuildGraphInput): ModuleGraph {
  const { modules, aliases, includeDynamic, includeTypeOnly } = input;
  const nodes = modules.map((m) => m.display).sort();
  const known = new Set(nodes);

  const edgeKeys = new Set<string>();
  const edges: ModuleEdge[] = [];
  const adjacency = new Map<string, string[]>();
  const adjSets = new Map<string, Set<string>>();
  for (const n of nodes) adjSets.set(n, new Set());
  const unresolvedLocal: Array<{ from: string; specifier: string }> = [];
  const unresolvedSeen = new Set<string>();

  for (const mod of modules) {
    const summary = summarizeModule(mod.ast, mod.display);
    // The specifiers that can form edges. summarizeModule already merges static
    // imports, re-export sources, and dynamic import()/require() into
    // `dependencies`; we re-derive the categories here to honor the toggles.
    const specs = collectEdgeSpecifiers(summary, includeDynamic, includeTypeOnly);

    for (const spec of specs) {
      const resolved = resolveSpecifier(mod.display, spec, known, aliases);
      if (resolved === null) continue; // external leaf
      if ("local" in resolved) {
        const key = `${mod.display} ${spec}`;
        if (!unresolvedSeen.has(key)) {
          unresolvedSeen.add(key);
          unresolvedLocal.push({ from: mod.display, specifier: spec });
        }
        continue;
      }
      const to = resolved.to;
      const ekey = `${mod.display} ${to}`;
      if (!edgeKeys.has(ekey)) {
        edgeKeys.add(ekey);
        edges.push({ from: mod.display, to, specifier: spec });
        adjSets.get(mod.display)!.add(to);
      }
    }
  }

  for (const n of nodes) {
    adjacency.set(n, Array.from(adjSets.get(n)!).sort());
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  unresolvedLocal.sort((a, b) => a.from.localeCompare(b.from) || a.specifier.localeCompare(b.specifier));

  return { nodes, edges, adjacency, unresolvedLocal };
}

/**
 * Derive the set of edge-forming specifiers from a module summary, honoring the
 * dynamic / type-only toggles.
 *  - Static `import`/`export ... from` value specifiers always count.
 *  - Type-only imports/exports count only when includeTypeOnly is true.
 *  - Dynamic import()/require() specifiers count only when includeDynamic is
 *    true. These appear in `dependencies` but not in `imports`/`exports`, so we
 *    detect them as deps not otherwise accounted for.
 */
function collectEdgeSpecifiers(
  summary: ReturnType<typeof summarizeModule>,
  includeDynamic: boolean,
  includeTypeOnly: boolean
): Set<string> {
  const out = new Set<string>();
  // Static imports.
  for (const imp of summary.imports) {
    if (imp.typeOnly && !includeTypeOnly) continue;
    out.add(imp.source);
  }
  // Re-export sources (`export { x } from "y"`, `export * from "y"`).
  for (const exp of summary.exports) {
    if (!exp.source) continue;
    if (exp.typeOnly && !includeTypeOnly) continue;
    out.add(exp.source);
  }
  // Dynamic import()/require(): present in dependencies, not in the static sets.
  if (includeDynamic) {
    const staticSpecs = new Set<string>();
    for (const imp of summary.imports) staticSpecs.add(imp.source);
    for (const exp of summary.exports) if (exp.source) staticSpecs.add(exp.source);
    for (const dep of summary.dependencies) {
      if (!staticSpecs.has(dep)) out.add(dep);
    }
  }
  return out;
}

/** A detected cycle: the ordered module path forming the loop (no repeated tail). */
export interface Cycle {
  /** Modules in loop order; edges connect consecutive entries and last -> first. */
  modules: string[];
  /** True when it is a single module importing itself (A -> A). */
  selfImport: boolean;
}

/**
 * Find every ELEMENTARY cycle in the import graph.
 *
 * Approach:
 *  1. Tarjan's algorithm partitions the graph into strongly-connected components
 *     (SCCs). Only SCCs with >1 node, or a single node carrying a self-loop,
 *     can contain a cycle — the rest are skipped, which bounds the expensive
 *     enumeration to the genuinely-cyclic regions.
 *  2. Within each such SCC, Johnson's algorithm enumerates the elementary
 *     circuits exactly once each (no rotations/duplicates of the same loop).
 *  3. Each circuit is normalized to a canonical rotation (starting at its
 *     lexicographically smallest member) so independent discoveries of the same
 *     loop compare equal, then de-duplicated defensively.
 *
 * `maxCycles` caps enumeration (dense graphs can have exponentially many
 * elementary circuits); when hit, enumeration stops early and the caller is told
 * via the returned `truncated` flag.
 */
export function findCycles(
  graph: Pick<ModuleGraph, "nodes" | "adjacency">,
  maxCycles = 1000
): { cycles: Cycle[]; truncated: boolean } {
  const sccs = tarjanSCC(graph);
  const cycles: Cycle[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const scc of sccs) {
    if (truncated) break;
    const sccSet = new Set(scc);
    const isSelfLoop = scc.length === 1 && (graph.adjacency.get(scc[0]!) ?? []).includes(scc[0]!);
    if (scc.length < 2 && !isSelfLoop) continue;

    const circuits = johnsonCircuits(scc, sccSet, graph.adjacency, maxCycles - cycles.length);
    if (circuits.truncated) truncated = true;

    for (const circuit of circuits.cycles) {
      const canonical = canonicalRotation(circuit);
      const key = canonical.join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      cycles.push({ modules: canonical, selfImport: canonical.length === 1 });
      if (cycles.length >= maxCycles) {
        truncated = true;
        break;
      }
    }
  }

  // Stable order: shortest cycles first, then lexicographically by member list.
  cycles.sort((a, b) => a.modules.length - b.modules.length || a.modules.join().localeCompare(b.modules.join()));
  return { cycles, truncated };
}

/** Rotate a cycle so it begins at its lexicographically smallest member. */
function canonicalRotation(cycle: string[]): string[] {
  if (cycle.length <= 1) return cycle.slice();
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i]! < cycle[minIdx]!) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

/** Tarjan's strongly-connected-components. Returns components as node arrays. */
function tarjanSCC(graph: Pick<ModuleGraph, "nodes" | "adjacency">): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  // Iterative DFS to avoid stack overflow on deep/large graphs.
  for (const start of graph.nodes) {
    if (index.has(start)) continue;
    type Frame = { node: string; neighbors: string[]; i: number };
    const callStack: Frame[] = [{ node: start, neighbors: graph.adjacency.get(start) ?? [], i: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i]!;
        frame.i++;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          callStack.push({ node: w, neighbors: graph.adjacency.get(w) ?? [], i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        }
      } else {
        // Done with this node: if it's an SCC root, pop the component.
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
          } while (w !== frame.node);
          result.push(component);
        }
        callStack.pop();
        const parent = callStack[callStack.length - 1];
        if (parent) {
          low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        }
      }
    }
  }
  return result;
}

/**
 * Johnson's elementary-circuit enumeration restricted to a single SCC.
 *
 * Adapted from Donald B. Johnson, "Finding all the elementary circuits of a
 * directed graph" (1975). Operates only on edges that stay within `sccSet`
 * (cross-SCC edges cannot be part of a circuit). Returns each elementary circuit
 * once as an ordered node list (NOT closing back to the start — the caller
 * treats it as a ring). Stops once `limit` circuits have been produced.
 */
function johnsonCircuits(
  sccNodes: string[],
  sccSet: Set<string>,
  fullAdjacency: Map<string, string[]>,
  limit: number
): { cycles: string[][]; truncated: boolean } {
  const cycles: string[][] = [];
  if (limit <= 0) return { cycles, truncated: true };

  // Adjacency restricted to this SCC, with a stable ordering.
  const adj = new Map<string, string[]>();
  for (const n of sccNodes) {
    adj.set(
      n,
      (fullAdjacency.get(n) ?? []).filter((m) => sccSet.has(m))
    );
  }

  // Single-node SCC with a self-loop: the only elementary circuit is [n].
  if (sccNodes.length === 1) {
    const n = sccNodes[0]!;
    if ((adj.get(n) ?? []).includes(n)) cycles.push([n]);
    return { cycles, truncated: false };
  }

  const blocked = new Set<string>();
  const blockMap = new Map<string, Set<string>>();
  const path: string[] = [];
  let truncated = false;
  // Fixed start node for this SCC (Johnson iterates least-vertex subgraphs, but
  // since we already isolated one SCC, every node is reachable from any other;
  // starting from each node in turn and skipping already-started nodes still
  // yields each elementary circuit exactly once).
  const order = [...sccNodes].sort();
  const startedFrom = new Set<string>();

  const unblock = (node: string): void => {
    blocked.delete(node);
    const set = blockMap.get(node);
    if (set) {
      for (const w of Array.from(set)) {
        set.delete(w);
        if (blocked.has(w)) unblock(w);
      }
    }
  };

  const circuit = (v: string, start: string): boolean => {
    if (truncated) return false;
    let foundClosing = false;
    path.push(v);
    blocked.add(v);

    for (const w of adj.get(v) ?? []) {
      // Only consider nodes not "removed" (those before `start` in `order`).
      if (startedFrom.has(w)) continue;
      if (w === start) {
        cycles.push([...path]);
        foundClosing = true;
        if (cycles.length >= limit) {
          truncated = true;
          path.pop();
          return foundClosing;
        }
      } else if (!blocked.has(w)) {
        if (circuit(w, start)) foundClosing = true;
        if (truncated) {
          path.pop();
          return foundClosing;
        }
      }
    }

    if (foundClosing) {
      unblock(v);
    } else {
      for (const w of adj.get(v) ?? []) {
        if (startedFrom.has(w)) continue;
        const set = blockMap.get(w) ?? new Set<string>();
        set.add(v);
        blockMap.set(w, set);
      }
    }
    path.pop();
    return foundClosing;
  };

  for (const start of order) {
    if (truncated) break;
    blocked.clear();
    blockMap.clear();
    circuit(start, start);
    // "Remove" this start node from further consideration so circuits through it
    // are not re-enumerated from a later start (the least-vertex constraint).
    startedFrom.add(start);
  }

  return { cycles, truncated };
}
