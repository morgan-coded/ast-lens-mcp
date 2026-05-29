/**
 * Package entry-point resolution.
 *
 * For unused-export analysis, the symbols a package intentionally exposes are
 * reachable from its declared entry points — `package.json`'s `main`, `module`,
 * `bin`, and `exports` fields. Treating those entry files as public API roots
 * (their own exports and anything they re-export) prevents false "unused"
 * reports for code that is reachable from a real entry but happens not to live
 * in an `index.*` file.
 *
 * The wrinkle: a published `package.json` points at BUILD OUTPUT (e.g.
 * `dist/index.js`), while this server analyzes SOURCE (`src/index.ts`). So each
 * declared entry is expanded into a small set of plausible source-file
 * candidates (swap a build dir for a source dir, swap a JS extension for a TS
 * one, also keep the literal path). Callers match these candidates against the
 * source files actually in scope; non-existent candidates simply never match.
 *
 * Everything here is pure + best-effort: a missing/invalid `package.json`, or
 * fields in unexpected shapes, yield no entry points rather than throwing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** Directory prefixes commonly used for build output. */
const BUILD_DIRS = ["dist", "build", "lib", "out", "es", "esm", "cjs", "umd", "output"];

/** Source directory prefixes a build dir might map back to (""=package root). */
const SOURCE_DIRS = ["src", "source", "lib", ""];

/** Source extensions to consider when a declared entry uses a JS extension. */
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts"];

/** All extensions this server can parse (kept as-is when already a source ext). */
const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

/** Normalize a declared specifier to a clean, root-relative posix path. */
function normalizeRel(spec: string): string | undefined {
  if (typeof spec !== "string" || spec.length === 0) return undefined;
  // Ignore bare-package or protocol specifiers; entry fields should be paths.
  if (/^[a-zA-Z]+:/.test(spec)) return undefined;
  let p = spec.replace(/\\/g, "/");
  // Strip a single leading "./"; leave deeper "../" alone (it would escape root
  // and simply never match an in-scope file, which is the safe outcome).
  if (p.startsWith("./")) p = p.slice(2);
  if (p === ".") return undefined;
  return p;
}

/**
 * Recursively collect string path leaves from an `exports`/`bin` value. Handles
 * a plain string, an array of strings, or a conditions/subpath object. Every
 * string leaf is collected — including `types`/`typings` condition values, since
 * a `.d.ts`-only package exposes its public surface there. Each leaf is later
 * expanded to source candidates, so a declaration entry simply contributes its
 * own (often source-resident) path.
 */
function collectLeaves(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const rel = normalizeRel(value);
    if (rel) out.add(rel);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeaves(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectLeaves(child, out);
    }
  }
}

/**
 * Expand one declared entry path into candidate SOURCE paths to match against
 * files in scope. Always includes the literal path; when it looks like build
 * output (a build dir prefix and/or a JS extension) it adds source-dir and
 * source-extension variants. Returns root-relative posix paths.
 */
export function expandEntryToSourceCandidates(rel: string): string[] {
  const candidates = new Set<string>();
  const literal = rel.replace(/\\/g, "/");
  candidates.add(literal);

  const ext = path.posix.extname(literal);
  const segments = literal.split("/");
  const firstSeg = segments[0];
  const inBuildDir = firstSeg !== undefined && BUILD_DIRS.includes(firstSeg);
  const isJsExt = ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".jsx";

  // Path bodies to try: the literal, and (if under a build dir) the same path
  // with the build dir replaced by each candidate source dir.
  const bodies = new Set<string>();
  const stripExt = (p: string) => (ext ? p.slice(0, p.length - ext.length) : p);
  bodies.add(stripExt(literal));
  if (inBuildDir) {
    const rest = segments.slice(1).join("/");
    for (const srcDir of SOURCE_DIRS) {
      const rebased = srcDir ? `${srcDir}/${rest}` : rest;
      bodies.add(stripExt(rebased));
    }
  }

  // Extensions to try: keep the original if it's a parseable source ext; if it's
  // a JS-family extension, also try the TS-family equivalents. A `.d.ts` entry
  // (handled via extname ".ts") keeps its body's trailing ".d".
  const exts = new Set<string>();
  if (ext) {
    if (SUPPORTED_EXTS.has(ext)) exts.add(ext);
    if (isJsExt) for (const e of SOURCE_EXTS) exts.add(e);
  } else {
    // Extension-less entry (rare): try every source/JS extension and /index.*.
    for (const e of SUPPORTED_EXTS) exts.add(e);
    for (const e of SOURCE_EXTS) exts.add(e);
  }

  for (const body of bodies) {
    for (const e of exts) candidates.add(`${body}${e}`);
  }
  // Always keep the verbatim literal even if it had no/odd extension.
  candidates.add(literal);
  return Array.from(candidates);
}

/** Extensions tried, in order, when resolving an extension-less specifier. */
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Map a JS-family import extension to the TS-family source extensions it may
 * actually resolve to. This is the ESM/NodeNext TypeScript convention where a
 * specifier is written with a `.js` extension (`import x from "./a.js"`) but the
 * file on disk is the source `./a.ts`. Without this, every such relative import
 * in a modern TS-ESM project resolves to nothing — so a symbol used only across
 * a `.js`-specified import would be wrongly reported as unused. Mirrors the
 * JS->TS expansion `expandEntryToSourceCandidates` applies to package entries.
 */
const JS_TO_TS_EXTS: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts", ".d.ts"],
  ".cjs": [".cts", ".d.ts"]
};

/** Extension of a posix path, lowercased, or "" if none. Recognizes ".d.ts". */
function posixExt(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base.endsWith(".d.ts")) return ".d.ts";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * Resolve a relative module specifier (`./x`, `../y/z`) referenced FROM a given
 * file to a concrete display path drawn from a known set of files. This is a
 * purely path-based resolution against files already in scope — no filesystem
 * access — so it works on the batch the tool already loaded.
 *
 * Tries, in order:
 *   1. the exact joined path (a fully-specified specifier like "./a.ts");
 *   2. if the path carries a JS-family extension, the TS-family source files it
 *      may map to under the ESM/NodeNext convention ("./a.js" -> a.ts/a.tsx/…);
 *   3. the (extension-less) joined path + each supported extension;
 *   4. `<joined-stem>/index.<ext>` for a directory import.
 *
 * Returns the first member of `known` that matches, or undefined when nothing in
 * scope satisfies it (bare package specifiers and out-of-scope targets simply do
 * not resolve).
 */
export function resolveRelativeSpecifier(
  fromDisplayPath: string,
  spec: string,
  known: Set<string>
): string | undefined {
  if (!(spec.startsWith("./") || spec.startsWith("../"))) return undefined;
  const fromDir = path.posix.dirname(fromDisplayPath.replace(/\\/g, "/"));
  // Guard: a specifier may resolve above the root ("../.."); such a path can
  // never be an in-scope file, and `known` won't contain it, so it is dropped.
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));

  // 1. Exact match (specifier written with its real extension).
  if (known.has(joined)) return joined;

  // 2. JS-family specifier -> TS-family source file (ESM/NodeNext convention).
  const ext = posixExt(joined);
  const tsSwaps = ext ? JS_TO_TS_EXTS[ext] : undefined;
  if (tsSwaps) {
    const stem = joined.slice(0, joined.length - ext.length);
    for (const e of tsSwaps) {
      if (known.has(`${stem}${e}`)) return `${stem}${e}`;
    }
  }

  // 3. Extension-less specifier: append each candidate extension. (When the
  // specifier already carries an extension we do NOT append more — that would
  // look for "./a.js.ts" — only the index fallback below remains meaningful.)
  if (!ext) {
    for (const e of RESOLVE_EXTS) {
      if (known.has(`${joined}${e}`)) return `${joined}${e}`;
    }
  }

  // 4. Directory index. Use the extension-less stem so "./dir.js" can also fall
  // back to "dir/index.*" as well as a bare "./dir".
  const stem = ext ? joined.slice(0, joined.length - ext.length) : joined;
  for (const e of RESOLVE_EXTS) {
    if (known.has(`${stem}/index${e}`)) return `${stem}/index${e}`;
  }
  return undefined;
}

/** The result of resolving a package's declared entry points. */
export interface EntryPointResolution {
  /** Whether a package.json was found and parsed. */
  found: boolean;
  /** Raw, normalized entry paths exactly as declared (root-relative). */
  declared: string[];
  /** Expanded source-file candidates (root-relative posix paths) to match. */
  sourceCandidates: string[];
}

/**
 * Read `<root>/package.json` and resolve declared entry points into source-file
 * candidates. Never throws: a missing or malformed manifest yields
 * `{ found: false, declared: [], sourceCandidates: [] }`.
 */
export async function resolvePackageEntryPoints(root: string): Promise<EntryPointResolution> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, "package.json"), "utf8");
  } catch {
    return { found: false, declared: [], sourceCandidates: [] };
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { found: false, declared: [], sourceCandidates: [] };
  }

  const declaredSet = new Set<string>();
  // main / module / types / typings: plain string paths. `types`/`typings` is
  // the canonical entry for a .d.ts-publishing package (e.g. type-fest), where
  // there may be no runtime `main` at all — its declaration barrel IS the public
  // surface, so it must seed roots.
  for (const field of ["main", "module", "types", "typings"] as const) {
    const rel = normalizeRel(typeof pkg[field] === "string" ? (pkg[field] as string) : "");
    if (rel) declaredSet.add(rel);
  }
  // bin: a string, or a map of command -> path.
  collectLeaves(pkg["bin"], declaredSet);
  // exports: string, array, or nested conditions/subpaths.
  collectLeaves(pkg["exports"], declaredSet);

  const declared = Array.from(declaredSet).sort();
  const candidateSet = new Set<string>();
  for (const rel of declared) {
    for (const c of expandEntryToSourceCandidates(rel)) candidateSet.add(c);
  }

  return {
    found: true,
    declared,
    sourceCandidates: Array.from(candidateSet).sort()
  };
}
