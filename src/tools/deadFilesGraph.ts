/**
 * Self-contained import-graph + reachability helper for `find_dead_files`.
 *
 * This file intentionally lives alongside the tool (not in `core/`) so the v0.4
 * dead-file work does not modify any shared core/tool module. It builds, from a
 * batch of parsed files, the directed "imports" graph (file A -> file B when A
 * has any static import, re-export, `require`, or statically-resolvable dynamic
 * `import()` of B) and computes which files are reachable from a set of entry
 * points.
 *
 * Module-specifier resolution is purely path-based against the files ALREADY in
 * scope (no extra filesystem reads): it understands relative paths (with
 * extension + `/index.*` resolution — reusing the same logic as the v0.3
 * entry-point resolver) and tsconfig `compilerOptions.paths` / `baseUrl`
 * aliases. Bare package specifiers and anything that does not resolve to an
 * in-scope file are simply dropped (they cannot be a same-repo dead-file edge).
 *
 * tsconfig path-alias resolution is NEW here: the v0.3 codebase does its
 * cross-file checks NAME-BASED and never resolves aliases to files, so there is
 * no existing helper to reuse for that. The relative-path resolver IS reused
 * from `core/entryPoints.ts` without modification.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import * as t from "@babel/types";
import { resolveRelativeSpecifier } from "../core/entryPoints.js";

/** Extensions tried, in order, when resolving a path-like specifier to a file. */
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

/** JS-family extensions that, in TS ESM/NodeNext code, are written on imports
 * but actually resolve to a TS source file (e.g. `import "./x.js"` -> x.ts). */
const REWRITABLE_JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/** A single tsconfig `paths` mapping, compiled for matching. */
interface AliasRule {
  /** The pattern text before a single optional `*` (e.g. "@lib/"). */
  prefix: string;
  /** The pattern text after the `*` (often ""). */
  suffix: string;
  /** Whether the pattern contained a `*` wildcard. */
  wildcard: boolean;
  /** Replacement targets (root-relative posix bodies), `*` already split into prefix/suffix. */
  targets: Array<{ prefix: string; suffix: string; wildcard: boolean }>;
}

/** Resolved tsconfig path-mapping configuration. */
export interface TsAliasConfig {
  /** Root-relative posix base directory for non-relative bare specifiers (baseUrl). undefined when unset. */
  baseUrl?: string;
  /** Compiled `paths` rules. */
  rules: AliasRule[];
}

/**
 * Read `<root>/tsconfig.json` and extract `compilerOptions.baseUrl` + `paths`.
 * Never throws: a missing/malformed tsconfig, or one without these fields,
 * yields `{ rules: [] }` (no aliasing). JSON is parsed leniently enough to
 * tolerate `// line` and `/* block *​/` comments and trailing commas, which are
 * legal in tsconfig but not in strict JSON.
 *
 * This does NOT walk `extends` chains or merge referenced project configs — it
 * reads the single root tsconfig only (documented limitation). Targets are
 * normalized to root-relative posix bodies (baseUrl applied, leading "./"
 * stripped) so they can be matched against in-scope display paths.
 */
export async function loadTsAliasConfig(root: string): Promise<TsAliasConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, "tsconfig.json"), "utf8");
  } catch {
    return { rules: [] };
  }

  let parsed: { compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  try {
    parsed = JSON.parse(stripJsonComments(raw)) as typeof parsed;
  } catch {
    return { rules: [] };
  }

  const co = parsed.compilerOptions;
  if (!co || typeof co !== "object") return { rules: [] };

  const baseUrlRaw = typeof co.baseUrl === "string" ? co.baseUrl : undefined;
  const baseUrl = baseUrlRaw !== undefined ? normalizeBody(baseUrlRaw) : undefined;

  const rules: AliasRule[] = [];
  const paths = co.paths;
  if (paths && typeof paths === "object") {
    for (const [pattern, targetsRaw] of Object.entries(paths as Record<string, unknown>)) {
      if (!Array.isArray(targetsRaw)) continue;
      const { prefix, suffix, wildcard } = splitWildcard(pattern);
      const targets: AliasRule["targets"] = [];
      for (const targetPattern of targetsRaw) {
        if (typeof targetPattern !== "string") continue;
        // A `paths` target is relative to baseUrl (default "." = project root).
        const split = splitWildcard(targetPattern);
        const base = baseUrl ?? "";
        const joinBody = (body: string): string => normalizeBody(base ? `${base}/${body}` : body);
        targets.push({
          prefix: joinBody(split.prefix),
          suffix: split.suffix,
          wildcard: split.wildcard
        });
      }
      if (targets.length > 0) rules.push({ prefix, suffix, wildcard, targets });
    }
  }

  return { ...(baseUrl !== undefined ? { baseUrl } : {}), rules };
}

/** Split a tsconfig pattern/target on its single optional `*` wildcard. */
function splitWildcard(pattern: string): { prefix: string; suffix: string; wildcard: boolean } {
  const star = pattern.indexOf("*");
  if (star === -1) return { prefix: pattern, suffix: "", wildcard: false };
  return { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), wildcard: true };
}

/** Normalize a path body to clean root-relative posix (drop "./", collapse "\\"). */
function normalizeBody(body: string): string {
  let p = body.replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  // Collapse any "a/./b" or duplicate slashes without resolving "..".
  p = p.replace(/\/+/g, "/").replace(/\/\.(?=\/|$)/g, "");
  if (p === ".") return "";
  return p;
}

/** Strip `//` and block comments and trailing commas from JSONC (tsconfig). */
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
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
        // Copy the escaped char verbatim.
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
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
  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Try to resolve a body (root-relative, no extension) to a concrete display
 * path present in `known`, attempting the bare body, each supported extension,
 * and `<body>/index.<ext>`.
 */
function matchBodyToKnown(body: string, known: Set<string>): string | undefined {
  const clean = normalizeBody(body);
  if (known.has(clean)) return clean;
  for (const e of RESOLVE_EXTS) {
    if (known.has(`${clean}${e}`)) return `${clean}${e}`;
  }
  for (const e of RESOLVE_EXTS) {
    if (known.has(`${clean}/index${e}`)) return `${clean}/index${e}`;
  }
  return undefined;
}

/**
 * Resolve a tsconfig path-aliased specifier (e.g. `@lib/aliased`, `@app`) to an
 * in-scope display path. Returns undefined when no alias rule matches or the
 * mapped target is not an in-scope file.
 */
export function resolveAliasSpecifier(
  spec: string,
  known: Set<string>,
  config: TsAliasConfig
): string | undefined {
  for (const rule of config.rules) {
    if (rule.wildcard) {
      if (!spec.startsWith(rule.prefix) || !spec.endsWith(rule.suffix)) continue;
      const captured = spec.slice(rule.prefix.length, spec.length - rule.suffix.length);
      for (const target of rule.targets) {
        const body = target.wildcard ? `${target.prefix}${captured}${target.suffix}` : target.prefix;
        const hit = matchBodyToKnown(body, known);
        if (hit) return hit;
      }
    } else {
      if (spec !== rule.prefix) continue;
      for (const target of rule.targets) {
        const hit = matchBodyToKnown(target.prefix, known);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

/**
 * Resolve a relative specifier (`./x`, `../y/z`) referenced from a file to an
 * in-scope display path, with TS-ESM extension rewriting. A specifier written
 * with a JS-family extension (`./server.js`, `./m.mjs`) is also tried with TS
 * source extensions, because TS ESM/NodeNext code imports `./x.js` to mean the
 * `x.ts` source. Falls back to the v0.3 relative resolver (reused unmodified)
 * for any case this does not cover.
 */
function resolveRelativeWithTsRewrite(
  fromDisplay: string,
  spec: string,
  known: Set<string>
): string | undefined {
  const fromDir = path.posix.dirname(fromDisplay.replace(/\\/g, "/"));
  const joinedRaw = path.posix.normalize(path.posix.join(fromDir, spec));
  const ext = path.posix.extname(joinedRaw);
  if (REWRITABLE_JS_EXTS.has(ext)) {
    // Strip the JS extension and let matchBodyToKnown try TS/JS extensions and
    // /index.* — this is what maps `./server.js` to `src/server.ts`.
    const body = joinedRaw.slice(0, joinedRaw.length - ext.length);
    const hit = matchBodyToKnown(body, known);
    if (hit) return hit;
  }
  // Delegate to the reused resolver (handles extensionless + literal-extension
  // cases, including `.ts`/`.tsx`/`/index.*`).
  return resolveRelativeSpecifier(fromDisplay, spec, known);
}

/**
 * Resolve any module specifier referenced FROM `fromDisplay` to a concrete
 * in-scope display path, or undefined when it does not resolve to an in-scope
 * file. Tries, in order: relative-path resolution (with TS-ESM `.js`->`.ts`
 * rewriting, otherwise the reused v0.3 resolver), then tsconfig alias
 * resolution, then a baseUrl-relative bare specifier.
 */
export function resolveSpecifier(
  fromDisplay: string,
  spec: string,
  known: Set<string>,
  config: TsAliasConfig
): string | undefined {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return resolveRelativeWithTsRewrite(fromDisplay, spec, known);
  }
  // Absolute paths and protocol/data URLs are never in-scope same-repo edges.
  if (spec.startsWith("/") || /^[a-zA-Z]+:/.test(spec)) return undefined;

  const aliased = resolveAliasSpecifier(spec, known, config);
  if (aliased) return aliased;

  // baseUrl-relative bare import (e.g. baseUrl="src", `import "x"` -> src/x).
  if (config.baseUrl !== undefined) {
    const body = config.baseUrl ? `${config.baseUrl}/${spec}` : spec;
    const hit = matchBodyToKnown(body, known);
    if (hit) return hit;
  }
  return undefined;
}

/** A module specifier extracted from a file, tagged by how it was written. */
export interface FileSpecifier {
  spec: string;
  /** True for `import("...")` / `require(...)` (vs. a static import/re-export). */
  dynamic: boolean;
}

/**
 * Collect every module specifier a file references, distinguishing STATIC
 * (`import`/`export ... from`) from DYNAMIC (`import("...")` / `require(...)`)
 * occurrences. Only string-literal dynamic specifiers are returned; a computed
 * or template-literal dynamic import (e.g. `import(`./x-${k}`)`) yields no
 * specifier — it cannot be statically resolved (a documented false-positive
 * source for the target module).
 */
export function collectFileSpecifiers(ast: t.File): FileSpecifier[] {
  const out: FileSpecifier[] = [];
  const seen = new Set<string>();
  const push = (spec: string, dynamic: boolean): void => {
    const key = `${dynamic ? "d" : "s"}:${spec}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ spec, dynamic });
  };

  for (const stmt of ast.program.body) {
    if (t.isImportDeclaration(stmt)) {
      push(stmt.source.value, false);
    } else if (t.isExportNamedDeclaration(stmt) && stmt.source) {
      push(stmt.source.value, false);
    } else if (t.isExportAllDeclaration(stmt)) {
      push(stmt.source.value, false);
    }
  }

  // Dynamic import("x") / require("x") anywhere in the file (string-literal arg).
  const visit = (node: t.Node | null | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (t.isCallExpression(node)) {
      const callee = node.callee;
      const firstArg = node.arguments[0];
      const isRequire = t.isIdentifier(callee) && callee.name === "require";
      const isDynamicImport = t.isImport(callee);
      if ((isRequire || isDynamicImport) && firstArg && t.isStringLiteral(firstArg)) {
        push(firstArg.value, true);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") {
        continue;
      }
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child as t.Node);
      } else if (value && typeof value === "object" && "type" in (value as object)) {
        visit(value as t.Node);
      }
    }
  };
  visit(ast.program);

  return out;
}

/** An entry in the resolved import graph. */
export interface GraphFile {
  display: string;
  ast: t.File;
}

/** The computed import graph + reachability over a batch of files. */
export interface ImportGraph {
  /** Every in-scope display path. */
  files: Set<string>;
  /** file -> set of in-scope files it imports (out-edges, static or dynamic). */
  imports: Map<string, Set<string>>;
  /** file -> set of in-scope files that import it (in-edges). */
  importedBy: Map<string, Set<string>>;
  /** Whether a file has at least one in-edge via a STATIC import/re-export. */
  staticallyImported: Set<string>;
  /** Whether a file has at least one in-edge via a DYNAMIC import()/require. */
  dynamicallyImported: Set<string>;
}

/**
 * Build the directed import graph for a batch of files. Each file's specifiers
 * are resolved against the in-scope file set; only edges to in-scope files are
 * recorded. Self-imports are ignored.
 */
export function buildImportGraph(graphFiles: GraphFile[], config: TsAliasConfig): ImportGraph {
  const files = new Set<string>();
  for (const f of graphFiles) files.add(f.display);

  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  const staticallyImported = new Set<string>();
  const dynamicallyImported = new Set<string>();
  for (const display of files) {
    imports.set(display, new Set());
    importedBy.set(display, new Set());
  }

  for (const f of graphFiles) {
    for (const { spec, dynamic } of collectFileSpecifiers(f.ast)) {
      const target = resolveSpecifier(f.display, spec, files, config);
      if (!target || target === f.display) continue;
      imports.get(f.display)!.add(target);
      importedBy.get(target)!.add(f.display);
      if (dynamic) dynamicallyImported.add(target);
      else staticallyImported.add(target);
    }
  }

  return { files, imports, importedBy, staticallyImported, dynamicallyImported };
}

/**
 * Compute the set of files reachable from `roots` by following import out-edges
 * (BFS). Terminates on cycles. Roots not present in the graph are ignored.
 */
export function reachableFrom(graph: ImportGraph, roots: Iterable<string>): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) {
    if (graph.files.has(r) && !reached.has(r)) {
      reached.add(r);
      queue.push(r);
    }
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const next of graph.imports.get(file) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}
