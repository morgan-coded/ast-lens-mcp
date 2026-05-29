/**
 * Module import/export resolution graph.
 *
 * Turns a set of parsed files into a real module dependency graph: every scanned
 * file is a NODE, and every import / re-export / dynamic import is an EDGE from
 * the importing module to the imported one, carrying the symbol names that cross
 * the edge. Each edge records how its specifier resolved:
 *
 *   - "internal": resolved to another file inside the scanned scope (the edge
 *     `to` is that file's display path).
 *   - "external": a bare package specifier (e.g. "react", "node:fs"); recorded
 *     but NOT traversed — node_modules is never resolved or parsed.
 *   - "unresolved": a relative/aliased specifier that pointed at no file in
 *     scope (a typo, a missing file, or a target outside the scanned set).
 *
 * Resolution is path-based and dependency-free, mirroring find_unused_exports'
 * resolveRelativeSpecifier style: it works against the display paths of the
 * files already loaded in the batch, plus tsconfig `paths` aliases read from the
 * project root. It does NOT consult the filesystem for module resolution, so
 * targets outside the scanned scope simply do not resolve (a documented limit).
 *
 * Everything here is pure given an AST + the known-file set + the alias config,
 * which keeps it unit-testable and lets the tool layer stay thin.
 */
import * as t from "@babel/types";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spanOf } from "./parser.js";
import type { Span } from "./types.js";

/** Extensions tried, in order, when resolving an extension-less specifier.
 * Matches the order find_unused_exports uses in resolveRelativeSpecifier so the
 * two tools agree on which file a specifier points at. */
export const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
] as const;

/**
 * Map a JS-family import extension to the TS-family source extensions it may
 * actually resolve to. This is the ESM/NodeNext TypeScript convention where a
 * specifier is written with a `.js` extension (`import x from "./a.js"`) but the
 * file on disk is `./a.ts`. Without this, every such import in a modern TS ESM
 * project would be reported as unresolved. Mirrors the JS->TS expansion
 * entryPoints.ts applies to package entry paths (SOURCE_EXTS).
 */
const JS_TO_TS_EXTS: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts", ".d.ts"],
  ".cjs": [".cts", ".d.ts"]
};

/** How an edge's specifier was classified. */
export type EdgeResolution = "internal" | "external" | "unresolved";

/** The syntactic form that produced an edge. */
export type EdgeKind =
  | "import" // `import ... from "x"` (incl. side-effect `import "x"`)
  | "reexport" // `export { a } from "x"` / `export * from "x"` / `export * as ns from "x"`
  | "dynamic"; // `import("x")` / `require("x")`

/** One module-reference extracted from a single file's AST (before resolution). */
export interface ModuleReference {
  /** The module specifier exactly as written (e.g. "./util", "@lib/math", "react"). */
  specifier: string;
  kind: EdgeKind;
  /** Symbol names crossing this reference. For imports: the imported names
   * ("default", "*", or the named bindings). For re-exports: the origin-side
   * names being forwarded ("*" for a bare star). Empty for side-effect imports
   * and non-literal dynamic imports. */
  symbols: string[];
  /** True when the binding is purely a type (`import type`, `export type`). */
  typeOnly: boolean;
  span: Span;
}

/** A node in the import graph: a single module (source file). */
export interface ImportGraphNode {
  /** Display path of the module, relative to project root (forward slashes). */
  id: string;
}

/** A directed edge: `from` (an in-scope module) imports/re-exports `specifier`. */
export interface ImportGraphEdge {
  /** Display path of the importing module. */
  from: string;
  /** The module specifier as written. */
  specifier: string;
  /** Display path of the resolved target when `resolution === "internal"`, else null. */
  to: string | null;
  kind: EdgeKind;
  resolution: EdgeResolution;
  /** Symbol names crossing the edge (imported / re-exported names). */
  symbols: string[];
  typeOnly: boolean;
  span: Span;
}

/** tsconfig path-alias configuration, normalized for resolution. */
export interface AliasConfig {
  /** Root-relative posix base directory for non-relative resolution (default "."). */
  baseUrl: string;
  /** Each `paths` entry as a matcher: an exact key or a single-wildcard prefix,
   * with its root-relative posix target templates. */
  entries: AliasEntry[];
}

interface AliasEntry {
  /** The literal portion before a `*` (or the whole key when no wildcard). */
  prefix: string;
  /** The literal portion after a `*` (empty when the key ends with `*` or has none). */
  suffix: string;
  /** True when the pattern contained a `*` wildcard. */
  wildcard: boolean;
  /** Target templates (root-relative posix), each possibly containing one `*`. */
  targets: string[];
}

/**
 * A specifier is "relative" (path-based) when it starts with `./` or `../`. Bare
 * specifiers (package names, `@scope/pkg`, `node:fs`) and absolute paths are not.
 */
export function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * Resolve a path body against a set of known display paths. Tries, in order:
 *   1. the exact path (a fully-specified specifier like "./a.ts");
 *   2. if the path carries a JS-family extension, the TS-family source files it
 *      may map to under the ESM/NodeNext convention ("./a.js" -> a.ts/a.tsx/…);
 *   3. the (extension-less) path + each supported extension;
 *   4. `<path>/index.<ext>` for a directory import.
 *
 * Returns the first member of `known` that matches. `body` must be a normalized,
 * root-relative posix path. Returns undefined when nothing in scope satisfies it.
 */
function resolveBody(body: string, known: Set<string>): string | undefined {
  // 1. Exact match (handles specifiers written with their real extension).
  if (known.has(body)) return body;

  // 2. JS-family specifier -> TS-family source file (ESM/NodeNext convention).
  const ext = posixExt(body);
  const tsSwaps = ext ? JS_TO_TS_EXTS[ext] : undefined;
  if (tsSwaps) {
    const stem = body.slice(0, body.length - ext.length);
    for (const e of tsSwaps) {
      if (known.has(`${stem}${e}`)) return `${stem}${e}`;
    }
  }

  // If the body already has a known extension, do NOT also try appending more
  // extensions to it (that would look for "./a.ts.ts"); only the index fallback
  // remains meaningful (for the rare "import './dir.js'" -> dir/index.* case).
  if (!ext) {
    // 3. Extension-less: append each candidate extension.
    for (const e of RESOLVE_EXTENSIONS) {
      if (known.has(`${body}${e}`)) return `${body}${e}`;
    }
  }

  // 4. Directory index. Use the extension-less stem so "./dir.js" can fall back
  // to "dir/index.*" as well as a bare "./dir".
  const stem = ext ? body.slice(0, body.length - ext.length) : body;
  for (const e of RESOLVE_EXTENSIONS) {
    if (known.has(`${stem}/index${e}`)) return `${stem}/index${e}`;
  }
  return undefined;
}

/** Extension of a posix path, lowercased, or "" if none. Recognizes ".d.ts". */
function posixExt(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base.endsWith(".d.ts")) return ".d.ts";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * Try to resolve a non-relative specifier through tsconfig `paths` aliases.
 *
 * For an exact-key entry the specifier must equal the key; for a wildcard entry
 * the specifier must start with the prefix and end with the suffix, and the
 * captured `*` segment is substituted into each target template. Every resulting
 * candidate body is resolved against `known` (with extension/index inference).
 * Returns the first in-scope match, or undefined.
 */
function resolveAlias(spec: string, known: Set<string>, alias: AliasConfig): string | undefined {
  for (const entry of alias.entries) {
    let bodies: string[];
    if (!entry.wildcard) {
      if (spec !== entry.prefix) continue;
      bodies = entry.targets.map((tpl) => normalizeRootRel(tpl));
    } else {
      if (!spec.startsWith(entry.prefix) || !spec.endsWith(entry.suffix)) continue;
      const captured = spec.slice(entry.prefix.length, spec.length - entry.suffix.length);
      // A wildcard entry whose suffix overlaps the prefix on a too-short
      // specifier could produce a negative slice; guard it.
      if (spec.length < entry.prefix.length + entry.suffix.length) continue;
      bodies = entry.targets.map((tpl) => normalizeRootRel(tpl.replace("*", captured)));
    }
    for (const body of bodies) {
      // Strip a known source extension from the template body so resolveBody can
      // re-add the right one (a template like "src/config/index.ts" should still
      // match the file "src/config/index.ts" — resolveBody handles the exact
      // case first, so passing the body verbatim is correct).
      const hit = resolveBody(body, known);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Normalize a path to a clean, root-relative posix string (no leading "./"). */
function normalizeRootRel(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  return path.posix.normalize(s);
}

/**
 * Resolve one specifier referenced FROM a given module to an in-scope display
 * path, classifying the result.
 *
 *   - Relative (`./x`, `../y`): join against the importer's directory, then
 *     resolve with extension/index inference. In-scope hit => internal; else
 *     unresolved.
 *   - Non-relative: try tsconfig `paths` aliases (=> internal on a hit). If no
 *     alias matches it is a bare PACKAGE specifier => external (never traversed).
 *
 * Absolute specifiers (rare in source) are treated as unresolved — this server
 * resolves against scoped display paths, not the host filesystem.
 */
export function resolveSpecifier(
  fromDisplayPath: string,
  spec: string,
  known: Set<string>,
  alias: AliasConfig
): { to: string | null; resolution: EdgeResolution } {
  if (isRelativeSpecifier(spec)) {
    const fromDir = path.posix.dirname(fromDisplayPath.replace(/\\/g, "/"));
    const joined = path.posix.normalize(path.posix.join(fromDir, spec));
    const hit = resolveBody(joined, known);
    return hit ? { to: hit, resolution: "internal" } : { to: null, resolution: "unresolved" };
  }

  // Non-relative: attempt alias resolution first.
  const aliased = resolveAlias(spec, known, alias);
  if (aliased) return { to: aliased, resolution: "internal" };

  // Absolute path specifier: cannot be mapped to a scoped display path.
  if (spec.startsWith("/")) return { to: null, resolution: "unresolved" };

  // A bare specifier that no alias claimed is an external package import.
  return { to: null, resolution: "external" };
}

/**
 * Extract every module reference (import / re-export / dynamic import) from a
 * single file's AST, with the symbol names that cross each reference. Pure: no
 * filesystem access, no resolution.
 */
export function extractModuleReferences(ast: t.File): ModuleReference[] {
  const refs: ModuleReference[] = [];

  for (const stmt of ast.program.body) {
    // import ... from "x"  /  import "x"  (side-effect)
    if (t.isImportDeclaration(stmt)) {
      const symbols: string[] = [];
      for (const spec of stmt.specifiers) {
        if (t.isImportDefaultSpecifier(spec)) symbols.push("default");
        else if (t.isImportNamespaceSpecifier(spec)) symbols.push("*");
        else if (t.isImportSpecifier(spec)) {
          symbols.push(t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value);
        }
      }
      refs.push({
        specifier: stmt.source.value,
        kind: "import",
        symbols,
        typeOnly: stmt.importKind === "type",
        span: spanOf(stmt)
      });
      continue;
    }

    // export { a, b as c } from "x"  /  export * as ns from "x"
    if (t.isExportNamedDeclaration(stmt) && stmt.source) {
      const symbols: string[] = [];
      for (const spec of stmt.specifiers) {
        if (t.isExportSpecifier(spec)) {
          // Origin-side name (what the source module exports). `a as c` forwards `a`.
          symbols.push(spec.local.name);
        } else if (t.isExportNamespaceSpecifier(spec)) {
          symbols.push("*");
        }
      }
      refs.push({
        specifier: stmt.source.value,
        kind: "reexport",
        symbols,
        typeOnly: stmt.exportKind === "type",
        span: spanOf(stmt)
      });
      continue;
    }

    // export * from "x"  (bare star re-export)
    if (t.isExportAllDeclaration(stmt)) {
      refs.push({
        specifier: stmt.source.value,
        kind: "reexport",
        symbols: ["*"],
        typeOnly: stmt.exportKind === "type",
        span: spanOf(stmt)
      });
    }
  }

  // Dynamic import("x") / require("x") with a STRING-LITERAL specifier, anywhere
  // in the file. Non-literal specifiers (template strings, variables) cannot be
  // statically resolved and are skipped (documented limitation).
  collectDynamicReferences(ast, refs);

  return refs;
}

/** Walk for `import("x")` and `require("x")` calls with literal specifiers. */
function collectDynamicReferences(ast: t.File, out: ModuleReference[]): void {
  const visit = (node: t.Node | null | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (t.isCallExpression(node)) {
      const callee = node.callee;
      const firstArg = node.arguments[0];
      const isRequire = t.isIdentifier(callee) && callee.name === "require";
      const isDynamicImport = t.isImport(callee);
      if ((isRequire || isDynamicImport) && firstArg && t.isStringLiteral(firstArg)) {
        out.push({
          specifier: firstArg.value,
          kind: "dynamic",
          symbols: [],
          typeOnly: false,
          span: spanOf(node)
        });
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
}

/** Parsed input for {@link buildImportGraph}: one entry per in-scope file. */
export interface GraphFileInput {
  /** Display path (root-relative, forward slashes). */
  display: string;
  ast: t.File;
}

/** Options governing graph construction. */
export interface BuildImportGraphOptions {
  /** Keep edges to external (node_modules) packages. Default false. */
  includeExternal: boolean;
}

/** The assembled import graph plus summary tallies. */
export interface ImportGraphResult {
  nodes: ImportGraphNode[];
  edges: ImportGraphEdge[];
  /** Count of edges resolved to an in-scope module. */
  internalCount: number;
  /** Count of distinct external package specifiers referenced (pre-filter). */
  externalCount: number;
  /** Count of unresolved relative/aliased specifiers. */
  unresolvedCount: number;
}

/**
 * Build the import graph for a set of in-scope files.
 *
 * Nodes are exactly the input files (the modules actually scanned). Edges are
 * every reference resolved against the in-scope file set + alias config. External
 * edges are tallied and (optionally) emitted but never traversed; their target
 * `to` is null. Unresolved edges (no in-scope file, no alias, not a bare package)
 * are always emitted so callers can see import typos / out-of-scope targets.
 *
 * Edges are returned sorted by (from, line) for stable output. Symbol lists on
 * each edge are de-duplicated but otherwise preserved as written.
 */
export function buildImportGraph(
  files: GraphFileInput[],
  alias: AliasConfig,
  opts: BuildImportGraphOptions
): ImportGraphResult {
  const known = new Set(files.map((f) => f.display));
  const nodes: ImportGraphNode[] = files.map((f) => ({ id: f.display }));

  const edges: ImportGraphEdge[] = [];
  let internalCount = 0;
  const externalSpecifiers = new Set<string>();
  let unresolvedCount = 0;

  for (const file of files) {
    for (const ref of extractModuleReferences(file.ast)) {
      const { to, resolution } = resolveSpecifier(file.display, ref.specifier, known, alias);

      if (resolution === "internal") internalCount++;
      else if (resolution === "external") externalSpecifiers.add(ref.specifier);
      else unresolvedCount++;

      // External edges are not traversed; emit them only when requested.
      if (resolution === "external" && !opts.includeExternal) continue;

      edges.push({
        from: file.display,
        specifier: ref.specifier,
        to,
        kind: ref.kind,
        resolution,
        symbols: dedupe(ref.symbols),
        typeOnly: ref.typeOnly,
        span: ref.span
      });
    }
  }

  edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.span.start.line - b.span.start.line ||
      a.specifier.localeCompare(b.specifier)
  );

  return {
    nodes,
    edges,
    internalCount,
    externalCount: externalSpecifiers.size,
    unresolvedCount
  };
}

function dedupe(names: string[]): string[] {
  return Array.from(new Set(names));
}

/**
 * Read `<root>/tsconfig.json` and extract a normalized {@link AliasConfig} from
 * `compilerOptions.baseUrl` + `compilerOptions.paths`. Never throws: a missing,
 * unreadable, or malformed tsconfig (or one without `paths`) yields an empty
 * alias set (`{ baseUrl: ".", entries: [] }`), so resolution falls back to
 * relative-only — non-relative specifiers then all classify as external.
 *
 * tsconfig permits JSONC (comments + trailing commas); we strip those defensively
 * before parsing. `extends` is NOT followed (best-effort, dependency-free) — a
 * documented limitation. baseUrl/paths are read from this file only.
 */
export async function readTsconfigAliases(root: string): Promise<AliasConfig> {
  const empty: AliasConfig = { baseUrl: ".", entries: [] };

  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(root, name), "utf8");
    } catch {
      continue; // try the next candidate
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch {
      return empty; // present but malformed — fall back to relative-only
    }

    return aliasConfigFromTsconfig(parsed, root);
  }

  return empty;
}

/** Build an AliasConfig from a parsed tsconfig object. Exposed for unit tests. */
export function aliasConfigFromTsconfig(parsed: unknown, root: string): AliasConfig {
  const empty: AliasConfig = { baseUrl: ".", entries: [] };
  if (!parsed || typeof parsed !== "object") return empty;

  const compilerOptions = (parsed as Record<string, unknown>)["compilerOptions"];
  if (!compilerOptions || typeof compilerOptions !== "object") return empty;
  const co = compilerOptions as Record<string, unknown>;

  const baseUrlRaw = typeof co["baseUrl"] === "string" ? (co["baseUrl"] as string) : ".";
  const baseUrl = normalizeRootRel(baseUrlRaw) || ".";

  const pathsRaw = co["paths"];
  const entries: AliasEntry[] = [];
  if (pathsRaw && typeof pathsRaw === "object") {
    for (const [key, value] of Object.entries(pathsRaw as Record<string, unknown>)) {
      const targets = collectStringTargets(value);
      if (targets.length === 0) continue;

      // Resolve each target relative to baseUrl (TS resolves `paths` against
      // baseUrl), keeping any single `*` placeholder intact.
      const resolvedTargets = targets.map((tpl) => joinBase(baseUrl, tpl));

      const starIdx = key.indexOf("*");
      if (starIdx === -1) {
        entries.push({ prefix: key, suffix: "", wildcard: false, targets: resolvedTargets });
      } else {
        entries.push({
          prefix: key.slice(0, starIdx),
          suffix: key.slice(starIdx + 1),
          wildcard: true,
          targets: resolvedTargets
        });
      }
    }
  }

  // Longer, more specific prefixes first so an exact/longer alias wins over a
  // broad one (e.g. "@lib/special/*" before "@lib/*").
  entries.sort((a, b) => b.prefix.length - a.prefix.length);

  return { baseUrl, entries };
}

/** Join a `paths` target template onto baseUrl, preserving a `*` placeholder. */
function joinBase(baseUrl: string, target: string): string {
  const star = target.includes("*");
  if (star) {
    const [head, ...rest] = target.split("*");
    const tail = rest.join("*"); // tolerate (invalid) multi-star by keeping extras literal
    const joinedHead = normalizeRootRel(path.posix.join(baseUrl, head ?? ""));
    return `${joinedHead}*${tail}`;
  }
  return normalizeRootRel(path.posix.join(baseUrl, target));
}

/** Collect string leaves from a `paths` value (a string or array of strings). */
function collectStringTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Strip `//` line comments, block comments, and trailing commas from a JSONC
 * string so JSON.parse accepts a typical tsconfig. String-literal aware so a
 * `//` or `,` inside a quoted value is preserved.
 */
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

  // Remove trailing commas (",}" / ",]") that JSON.parse rejects. Safe to run on
  // the comment-stripped, outside-strings text.
  return out.replace(/,(\s*[}\]])/g, "$1");
}
