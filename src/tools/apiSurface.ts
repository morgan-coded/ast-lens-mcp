/**
 * Tool: api_surface
 *
 * Extracts the PUBLIC API surface of a package or module: the symbols actually
 * reachable from the package's entry point(s), each with its kind and a
 * best-effort signature/type string — so an agent can understand what a package
 * exposes without reading every file.
 *
 * Reachability model (purely syntactic, no type-checking):
 *   1. Determine entry FILES. If `target` is a single file, that file is the
 *      entry. If it is a package directory (or a glob/dir), entry files come
 *      from its package.json (main/module/types/typings/bin/exports), mapped
 *      from declared build output back to likely source files (reusing the
 *      v0.3 resolver), restricted to files actually in scope.
 *   2. From each entry, collect the public exported names: locally-declared
 *      exports (with their declaration node, for signatures) AND re-exports
 *      (`export { x } from "./y"`, `export * from "./y"`, `export * as ns from
 *      "./y"`). Re-exported origin files are resolved against the in-scope batch
 *      and followed transitively, so a symbol forwarded through a barrel is
 *      attributed to its real declaration. A bare `export *` pulls in all of the
 *      target module's public exports.
 *   3. Emit, per entry, the de-duplicated public symbols with name, kind,
 *      signature, the file that declares them, and (for classes/interfaces/
 *      enums) their members.
 *
 * Built entirely on existing read-only helpers: file discovery + path safety
 * via core/files.ts (through ServerContext.loadBatch), package entry resolution
 * + relative-specifier resolution from core/entryPoints.ts, and signature
 * extraction from the new core/signature.ts. No existing tool/core file is
 * modified.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as t from "@babel/types";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import {
  expandEntryToSourceCandidates,
  resolvePackageEntryPoints,
  resolveRelativeSpecifier
} from "../core/entryPoints.js";
import { spanOf } from "../core/parser.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import {
  declarationSignature,
  variableDeclaratorSignature,
  type MemberSignature
} from "../core/signature.js";
import { kindOfDeclaration } from "../core/traverse.js";
import type { Span, SymbolKind } from "../core/types.js";
import { responseFormatSchema, targetSchema } from "./shared.js";

/** A single public symbol on a package's API surface. */
interface PublicSymbol {
  /** Public (exported) name. */
  name: string;
  kind: SymbolKind;
  /** How it leaves the entry: a named export or the default export. */
  exportKind: "named" | "default";
  /** Best-effort one-line signature/type string. */
  signature: string;
  /** File that DECLARES the symbol (relative to root), when resolvable. */
  declaredIn?: string;
  /** Members of a class/interface/enum, when applicable. */
  members?: MemberSignature[];
  /** True for a type-only export (`export type { T }` / `export type ...`). */
  typeOnly?: boolean;
  span: Span;
}

/** A bare `export * from "..."` whose target could not be resolved in scope. */
interface UnresolvedReexport {
  /** The entry/barrel file that declared the re-export (relative to root). */
  from: string;
  /** The module specifier as written (e.g. "./external" or "some-pkg"). */
  source: string;
  kind: "star" | "named";
  /** For a named re-export that did not resolve, the names involved. */
  names?: string[];
}

/** The resolved public surface for a single entry point. */
interface EntrySurface {
  /** Entry file path relative to root. */
  entry: string;
  symbols: PublicSymbol[];
  /** Re-exports from this entry (or its barrels) that could not be resolved. */
  unresolved: UnresolvedReexport[];
}

const inputSchema = z
  .object({
    target: targetSchema
      .describe(
        "Either a SINGLE entry file (e.g. \"src/index.ts\") or a PACKAGE directory containing package.json (e.g. \".\" or \"packages/core\"). " +
          "For a package, entry points are read from package.json (main/module/types/typings/bin/exports). " +
          "Re-exports are followed only within files in scope, so point at the package root (or a self-contained sub-package) for a complete surface."
      ),
    includeMembers: z
      .boolean()
      .default(true)
      .describe(
        "Include public class/interface members and enum members with their signatures. Set false for a flat top-level surface only. Default: true."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(1000)
      .describe("Maximum public symbols to return across all entries (default: 1000)."),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerApiSurface(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "api_surface",
    {
      title: "API Surface",
      description: `Extract the PUBLIC API surface of a package or module — the symbols actually reachable from its entry point(s), each with its kind and a best-effort signature — so you can understand what a package exposes without reading every file.

This is a fast, dependency-free, SYNTACTIC analysis (no type-checking). It resolves entry points, follows re-exports across files in scope, and reports each public symbol with a signature sliced from source.

What counts as "public": a symbol is on the surface when it is reachable from an entry point — either declared-and-exported by an entry, or re-exported by an entry (\`export { x } from "./y"\`, \`export * from "./y"\`, \`export * as ns from "./y"\`), transitively through barrel files. Internal symbols that are exported by a non-entry module but never re-exported from an entry are NOT included.

Entry points:
  - If 'target' is a single file, that file is the sole entry.
  - If 'target' is a package directory, entries come from its package.json (main/module/types/typings/bin/exports). Declared build-output paths (e.g. "dist/index.js") are mapped back to likely source files ("src/index.ts", ".d.ts", same-name variants); only candidates that exist in scope are used.

Signatures (best-effort, syntactic):
  - function: name + parameter list + return type, exactly as written (incl. generics, async).
  - class: \`class Name extends X implements Y\` header, plus public members (private/protected/#private omitted) with their signatures.
  - interface: \`interface Name<…> extends …\` plus its member signatures.
  - type: \`type Name<…> = <right-hand side>\`.
  - enum: \`enum Name\` plus member names.
  - const/let/var: \`const name: Type\` from the annotation; if un-annotated, a coarse value-shape hint (e.g. \`(…) => …\`, \`string\`) — NOT inferred types.

Args:
  - target (string): a single entry file OR a package directory with package.json.
  - includeMembers (boolean): include class/interface/enum members (default true).
  - limit (number): max public symbols across all entries, 1-5000 (default 1000).
  - response_format ('json' | 'markdown'): output format (default 'json').

Returns (JSON):
  {
    "target": string,
    "packageEntryPoints": string[],     // entries declared in package.json (root-relative), if any
    "entries": [
      {
        "entry": string,                // entry file, relative to root
        "symbols": [
          { "name": string, "kind": "function"|"class"|"interface"|"type"|"enum"|"const"|...,
            "exportKind": "named"|"default", "signature": string,
            "declaredIn"?: string, "typeOnly"?: boolean,
            "members"?: [ { "name", "kind", "signature", "static"?, "optional"?, "span" } ],
            "span": {...} }
        ],
        "unresolved": [ { "from": string, "source": string, "kind": "star"|"named", "names"?: string[] } ]
      }
    ],
    "totalSymbols": number,             // distinct public symbols across entries (before limit)
    "count": number,                    // returned
    "truncated": boolean,
    "parseErrors": [...]
  }

Examples:
  - "What's the public API of this package?" -> target="." (reads package.json)
  - "What does src/index.ts expose?" -> target="src/index.ts"
  - "Public surface of the core sub-package" -> target="packages/core"

IMPORTANT limits (syntactic / name-based):
  - Re-export targets are resolved only among files in scope; a re-export from a bare package or an out-of-scope path is reported under 'unresolved' (and a bare \`export *\` from such a target contributes nothing). Point 'target' at a self-contained package for completeness.
  - Signatures reproduce SOURCE text; inferred types of un-annotated values are not computed.
  - Default exports of a bare expression (\`export default foo()\`) appear as "default" with a best-effort shape only.
  - Dynamic / computed re-exports are invisible to a syntactic check.`,
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: Input) => {
      try {
        // Load the whole project once so re-export targets are resolvable no
        // matter where the entry sits; we narrow to the entry set below. (The
        // shared file-discovery layer enforces the project-root sandbox.)
        const batch = await ctx.loadBatch("**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}");

        // Index parsed files by display path for re-export resolution.
        const byDisplay = new Map<string, { ast: t.File; code: string }>();
        const knownPaths = new Set<string>();
        for (const parsed of batch.parsed) {
          const display = ctx.display(parsed.file);
          byDisplay.set(display, { ast: parsed.ast, code: parsed.code });
          knownPaths.add(display);
        }

        // --- Determine entry files -------------------------------------------------
        // A single-file target IS the entry. A directory/glob target reads
        // package.json from the resolved package dir for entry points.
        const { entryFiles, packageEntryPoints, entryError } = await resolveEntryFiles(
          ctx,
          input.target,
          knownPaths
        );
        if (entryError) {
          return errorResult(entryError.message, entryError.suggestion);
        }
        if (entryFiles.length === 0) {
          return errorResult(
            `No resolvable entry point found for "${input.target}".`,
            "Pass a single source entry file (e.g. \"src/index.ts\") or a package directory whose package.json declares main/module/types/exports pointing at in-scope source."
          );
        }

        // --- Resolve the public surface per entry ---------------------------------
        const entries: EntrySurface[] = [];
        for (const entry of entryFiles) {
          entries.push(resolveSurface(entry, byDisplay, knownPaths, input.includeMembers));
        }

        // Count distinct symbols across entries, then apply the global limit by
        // trimming whole symbols (entries keep their order).
        const totalSymbols = entries.reduce((n, e) => n + e.symbols.length, 0);
        let remaining = input.limit;
        const limitedEntries: EntrySurface[] = [];
        for (const e of entries) {
          if (remaining <= 0) {
            limitedEntries.push({ entry: e.entry, symbols: [], unresolved: e.unresolved });
            continue;
          }
          const taken = e.symbols.slice(0, remaining);
          remaining -= taken.length;
          limitedEntries.push({ entry: e.entry, symbols: taken, unresolved: e.unresolved });
        }
        const count = limitedEntries.reduce((n, e) => n + e.symbols.length, 0);

        const structured = {
          target: input.target,
          packageEntryPoints,
          entries: limitedEntries,
          totalSymbols,
          count,
          truncated: count < totalSymbols,
          parseErrors: batch.parseErrors,
          ...(batch.truncated ? { discoveryTruncated: true } : {})
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured),
          narrowHint: "Lower 'limit', target a single entry file, or set includeMembers=false."
        });
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : String(err),
          "Check that 'target' is a single entry file or a package directory inside the project root."
        );
      }
    }
  );
}

/** What `resolveEntryFiles` reports back. */
interface EntryResolution {
  entryFiles: string[];
  packageEntryPoints: string[];
  entryError?: { message: string; suggestion?: string };
}

/**
 * Resolve the set of entry FILES (display paths) for a target.
 *
 * - A target that resolves to exactly one in-scope file is that file.
 * - Otherwise the target is treated as a package directory: its package.json is
 *   read (via the v0.3 resolver) and the declared entries are mapped to source
 *   candidates, intersected with files in scope. The package.json is read from
 *   `<root>/<target>/package.json`, so a sub-package directory works too.
 */
async function resolveEntryFiles(
  ctx: ServerContext,
  target: string,
  knownPaths: Set<string>
): Promise<EntryResolution> {
  // Single-file target: discover it directly (this also runs the path-safety
  // sandbox). If it resolves to exactly one supported file, that's the entry.
  const direct = await ctx.loadBatch(target);
  if (direct.discovered === 1 && direct.parsed.length === 1) {
    const display = ctx.display(direct.parsed[0]!.file);
    return { entryFiles: [display], packageEntryPoints: [] };
  }
  if (direct.discovered === 1 && direct.parsed.length === 0) {
    // The single file exists but failed to parse — report it clearly.
    const e = direct.parseErrors[0];
    return {
      entryFiles: [],
      packageEntryPoints: [],
      entryError: {
        message: e ? `Entry file could not be parsed: ${e.file}: ${e.message}` : `Entry file could not be parsed.`,
        suggestion: "Fix the syntax error, or point 'target' at a parseable entry / package directory."
      }
    };
  }

  // Otherwise treat target as a package directory. Resolve package.json entries
  // from <root>/<target>. The resolver is rooted at the package dir so its
  // root-relative candidates must be re-based onto the project-root display
  // paths the batch is keyed by.
  const pkgRootAbs = resolvePackageDir(ctx.root, target);
  const resolution = await resolvePackageEntryPoints(pkgRootAbs);
  const packageEntryPoints = resolution.declared.map((d) => rebaseToProjectDisplay(ctx, pkgRootAbs, d));

  // Map each declared entry to its source candidates, re-based to project
  // display paths, and keep those that actually exist in scope.
  const entryFiles: string[] = [];
  const seen = new Set<string>();
  for (const declared of resolution.declared) {
    for (const candidate of expandEntryToSourceCandidates(declared)) {
      const display = rebaseToProjectDisplay(ctx, pkgRootAbs, candidate);
      if (knownPaths.has(display) && !seen.has(display)) {
        seen.add(display);
        entryFiles.push(display);
      }
    }
  }

  if (!resolution.found) {
    return {
      entryFiles: [],
      packageEntryPoints: [],
      entryError: {
        message: `"${target}" is neither a single source file nor a directory with a readable package.json.`,
        suggestion: "Pass a single entry file (e.g. \"src/index.ts\") or a package directory containing package.json."
      }
    };
  }

  return { entryFiles, packageEntryPoints };
}

/** Resolve a target package directory to an absolute path inside the root. */
function resolvePackageDir(root: string, target: string): string {
  // "." / "" / the root itself => the project root.
  if (target === "." || target === "" || target === "./") return root;
  // Strip a trailing slash; join under root. (Path-safety for entry FILES is
  // enforced when they are matched against the sandboxed batch's knownPaths.)
  const cleaned = target.replace(/\/+$/, "");
  return `${root}/${cleaned}`;
}

/** Re-base a package-dir-relative posix path to a project-root display path. */
function rebaseToProjectDisplay(ctx: ServerContext, pkgRootAbs: string, rel: string): string {
  // pkgRootAbs is `<root>` or `<root>/<sub>`; join then map back to a display path.
  return ctx.display(`${pkgRootAbs}/${rel}`);
}

/**
 * Resolve the public surface reachable from one entry file. Walks re-export
 * edges across the in-scope batch (named, star, and `export * as ns`),
 * attributing each public symbol to the file that declares it. Cycles are
 * handled by tracking visited (file, mode) states.
 */
function resolveSurface(
  entry: string,
  byDisplay: Map<string, { ast: t.File; code: string }>,
  knownPaths: Set<string>,
  includeMembers: boolean
): EntrySurface {
  const symbols: PublicSymbol[] = [];
  const unresolved: UnresolvedReexport[] = [];
  // De-dupe by public name within an entry (a name re-exported twice via
  // different paths still surfaces once). The first resolution wins.
  const seenNames = new Set<string>();

  /**
   * Collect public symbols from `file`. `nameFilter`, when set, restricts to a
   * subset of exported origin names (used when a parent forwarded specific names
   * via `export { a, b } from "./file"`); `renames` maps an origin name to the
   * public name it should appear under (for `export { a as b }`). When
   * `nameFilter` is undefined, ALL of the file's public exports are collected
   * (entry file itself, or a bare `export *` target).
   */
  const visit = (
    file: string,
    nameFilter: Set<string> | undefined,
    renames: Map<string, string>,
    visited: Set<string>
  ): void => {
    const stateKey = `${file}::${nameFilter ? [...nameFilter].sort().join(",") : "*"}`;
    if (visited.has(stateKey)) return;
    visited.add(stateKey);

    const mod = byDisplay.get(file);
    if (!mod) return;
    const { ast, code } = mod;

    for (const stmt of ast.program.body) {
      // export const/function/class/interface/type/enum ... (inline declaration)
      if (t.isExportNamedDeclaration(stmt) && stmt.declaration && !stmt.source) {
        collectInlineDeclaration(stmt, file, code, includeMembers, nameFilter, renames, seenNames, symbols);
        continue;
      }
      // export default ...
      if (t.isExportDefaultDeclaration(stmt)) {
        collectDefault(stmt, file, code, includeMembers, nameFilter, renames, seenNames, symbols);
        continue;
      }
      // export { a, b as c }  |  export { a, b as c } from "./y"  |  export type { ... }
      if (t.isExportNamedDeclaration(stmt) && !stmt.declaration) {
        handleNamedSpecifierExport(
          stmt,
          file,
          code,
          includeMembers,
          nameFilter,
          renames,
          seenNames,
          symbols,
          unresolved,
          byDisplay,
          knownPaths,
          visited,
          visit
        );
        continue;
      }
      // export * from "./y"  (bare star; `export * as ns` is an
      // ExportNamedDeclaration handled by the named-specifier branch above)
      if (t.isExportAllDeclaration(stmt)) {
        handleStarReexport(stmt, file, nameFilter, unresolved, knownPaths, visited, visit);
      }
    }
  };

  visit(entry, undefined, new Map(), new Set());
  return { entry, symbols, unresolved };
}

/** Whether the origin name passes the active filter; returns the public name to use. */
function publicNameFor(
  originName: string,
  nameFilter: Set<string> | undefined,
  renames: Map<string, string>
): string | undefined {
  if (nameFilter && !nameFilter.has(originName)) return undefined;
  return renames.get(originName) ?? originName;
}

/** Handle `export const/function/class/...` declared inline in this file. */
function collectInlineDeclaration(
  stmt: t.ExportNamedDeclaration,
  file: string,
  code: string,
  includeMembers: boolean,
  nameFilter: Set<string> | undefined,
  renames: Map<string, string>,
  seenNames: Set<string>,
  symbols: PublicSymbol[]
): void {
  const decl = stmt.declaration!;
  const typeOnly = stmt.exportKind === "type";

  // Variable declarations can bind several names; each is its own symbol.
  if (t.isVariableDeclaration(decl)) {
    const declKind = decl.kind === "const" ? "const" : decl.kind === "let" ? "let" : "var";
    for (const d of decl.declarations) {
      if (!t.isIdentifier(d.id)) continue;
      const origin = d.id.name;
      const publicName = publicNameFor(origin, nameFilter, renames);
      if (publicName === undefined || seenNames.has(publicName)) continue;
      const signature = variableDeclaratorSignature(declKind, d, code) ?? `${declKind} ${publicName}`;
      seenNames.add(publicName);
      symbols.push({
        name: publicName,
        kind: declKind,
        exportKind: "named",
        signature,
        declaredIn: file,
        ...(typeOnly ? { typeOnly: true } : {}),
        span: spanOf(d)
      });
    }
    return;
  }

  const kind = kindOfDeclaration(decl);
  if (!kind) return;
  const declName = declaredName(decl);
  if (declName === undefined) return;
  const publicName = publicNameFor(declName, nameFilter, renames);
  if (publicName === undefined || seenNames.has(publicName)) return;

  const sig = declarationSignature(decl, kind, code, publicName);
  seenNames.add(publicName);
  symbols.push({
    name: publicName,
    kind,
    exportKind: "named",
    signature: sig?.signature ?? publicName,
    declaredIn: file,
    ...(includeMembers && sig?.members ? { members: sig.members } : {}),
    ...(typeOnly ? { typeOnly: true } : {}),
    span: spanOf(decl)
  });
}

/** Handle `export default <decl|expr>`. */
function collectDefault(
  stmt: t.ExportDefaultDeclaration,
  file: string,
  code: string,
  includeMembers: boolean,
  nameFilter: Set<string> | undefined,
  renames: Map<string, string>,
  seenNames: Set<string>,
  symbols: PublicSymbol[]
): void {
  // A default export is reached as the origin name "default"; honor a filter
  // that explicitly lists it (rare: `export { default } from "./y"`).
  const publicName = publicNameFor("default", nameFilter, renames) ?? "default";
  if (nameFilter && !nameFilter.has("default")) return;
  if (seenNames.has(publicName)) return;

  const decl = stmt.declaration;
  if (t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl) || t.isTSDeclareFunction(decl)) {
    const kind = kindOfDeclaration(decl) ?? "unknown";
    const name = declaredName(decl) ?? "default";
    const sig = declarationSignature(decl, kind, code, name);
    seenNames.add(publicName);
    symbols.push({
      name: publicName,
      kind,
      exportKind: "default",
      signature: sig?.signature ?? name,
      declaredIn: file,
      ...(includeMembers && sig?.members ? { members: sig.members } : {}),
      span: spanOf(decl)
    });
    return;
  }
  // `export default <expression>` — no declaration kind; give a coarse shape.
  seenNames.add(publicName);
  symbols.push({
    name: publicName,
    kind: "unknown",
    exportKind: "default",
    signature: defaultExpressionShape(decl),
    declaredIn: file,
    span: spanOf(stmt)
  });
}

/** A coarse syntactic shape for a default-exported expression. */
function defaultExpressionShape(node: t.Node): string {
  if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
    const asyncPrefix = (node as { async?: boolean }).async ? "async " : "";
    return `${asyncPrefix}(…) => …`;
  }
  if (t.isObjectExpression(node)) return "object";
  if (t.isArrayExpression(node)) return "array";
  if (t.isIdentifier(node)) return node.name;
  if (t.isNewExpression(node) && t.isIdentifier(node.callee)) return node.callee.name;
  if (t.isCallExpression(node) && t.isIdentifier(node.callee)) return `${node.callee.name}(…)`;
  return "default";
}

/** Handle `export { a, b as c }` (local) and `export { a } from "./y"` (forwarded). */
function handleNamedSpecifierExport(
  stmt: t.ExportNamedDeclaration,
  file: string,
  code: string,
  includeMembers: boolean,
  nameFilter: Set<string> | undefined,
  renames: Map<string, string>,
  seenNames: Set<string>,
  symbols: PublicSymbol[],
  unresolved: UnresolvedReexport[],
  byDisplay: Map<string, { ast: t.File; code: string }>,
  knownPaths: Set<string>,
  visited: Set<string>,
  visit: VisitFn
): void {
  const typeOnly = stmt.exportKind === "type";
  // Build origin->public map for the specifiers (each `local as exported`).
  const originToPublic = new Map<string, string>();
  const originNames = new Set<string>();
  for (const spec of stmt.specifiers) {
    if (t.isExportNamespaceSpecifier(spec)) {
      // `export * as ns from "./y"` — a single namespace binding bundling the
      // whole target module. Emit it as one `namespace` symbol (its members are
      // the target's exports, which we do not expand here to keep the surface
      // flat). Only meaningful with a `from` source.
      if (!stmt.source) continue;
      const publicName = publicNameFor(spec.exported.name, nameFilter, renames);
      if (publicName === undefined || seenNames.has(publicName)) continue;
      const resolvedNs = resolveRelativeSpecifier(file, stmt.source.value, knownPaths);
      seenNames.add(publicName);
      symbols.push({
        name: publicName,
        kind: "namespace",
        exportKind: "named",
        signature: `namespace ${publicName} (* from "${stmt.source.value}")`,
        ...(resolvedNs ? { declaredIn: resolvedNs } : {}),
        ...(typeOnly ? { typeOnly: true } : {}),
        span: spanOf(spec)
      });
      if (!resolvedNs) {
        unresolved.push({ from: file, source: stmt.source.value, kind: "star" });
      }
      continue;
    }
    if (!t.isExportSpecifier(spec)) continue;
    const origin = spec.local.name;
    const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
    // Apply this entry's active filter/renames to the EXPORTED name (what the
    // parent sees), then record the origin->finalPublic mapping.
    const finalPublic = publicNameFor(exported, nameFilter, renames);
    if (finalPublic === undefined) continue;
    originToPublic.set(origin, finalPublic);
    originNames.add(origin);
  }
  if (originNames.size === 0) return;

  if (stmt.source) {
    // Forwarded re-export: resolve the source module in scope and recurse,
    // restricting to the origin names and carrying the rename mapping.
    const resolvedTarget = resolveRelativeSpecifier(file, stmt.source.value, knownPaths);
    if (!resolvedTarget) {
      unresolved.push({
        from: file,
        source: stmt.source.value,
        kind: "named",
        names: [...originNames]
      });
      return;
    }
    visit(resolvedTarget, originNames, originToPublic, visited);
    return;
  }

  // Local `export { x }` of a name declared in THIS file: find the declaration.
  for (const [origin, publicName] of originToPublic) {
    if (seenNames.has(publicName)) continue;
    const found = findLocalDeclaration(byDisplay.get(file)!.ast, origin);
    if (!found) continue;
    if (t.isVariableDeclarator(found.node)) {
      const declKind = found.declKind ?? "const";
      const signature = variableDeclaratorSignature(declKind, found.node, code) ?? `${declKind} ${publicName}`;
      seenNames.add(publicName);
      symbols.push({
        name: publicName,
        kind: declKind,
        exportKind: "named",
        signature,
        declaredIn: file,
        ...(typeOnly ? { typeOnly: true } : {}),
        span: spanOf(found.node)
      });
      continue;
    }
    const kind = kindOfDeclaration(found.node);
    if (!kind) continue;
    const sig = declarationSignature(found.node, kind, code, publicName);
    seenNames.add(publicName);
    symbols.push({
      name: publicName,
      kind,
      exportKind: "named",
      signature: sig?.signature ?? publicName,
      declaredIn: file,
      ...(includeMembers && sig?.members ? { members: sig.members } : {}),
      ...(typeOnly ? { typeOnly: true } : {}),
      span: spanOf(found.node)
    });
  }
}

/**
 * Handle a bare `export * from "./y"`. (`export * as ns from "./y"` is modeled
 * by Babel as an ExportNamedDeclaration with an ExportNamespaceSpecifier and is
 * handled in handleNamedSpecifierExport, so this only sees the unnamed star.)
 *
 * A bare star forwards EVERY public name of the target, so we recurse with no
 * additional name restriction beyond the parent's active filter, and with no
 * renames (a star cannot rename).
 */
function handleStarReexport(
  stmt: t.ExportAllDeclaration,
  file: string,
  nameFilter: Set<string> | undefined,
  unresolved: UnresolvedReexport[],
  knownPaths: Set<string>,
  visited: Set<string>,
  visit: VisitFn
): void {
  const resolvedTarget = resolveRelativeSpecifier(file, stmt.source.value, knownPaths);
  if (!resolvedTarget) {
    unresolved.push({ from: file, source: stmt.source.value, kind: "star" });
    return;
  }
  visit(resolvedTarget, nameFilter, new Map(), visited);
}

/** The declared id name of a non-variable declaration, if any. */
function declaredName(decl: t.Node): string | undefined {
  if (
    t.isFunctionDeclaration(decl) ||
    t.isTSDeclareFunction(decl) ||
    t.isClassDeclaration(decl) ||
    t.isTSInterfaceDeclaration(decl) ||
    t.isTSTypeAliasDeclaration(decl) ||
    t.isTSEnumDeclaration(decl)
  ) {
    return decl.id ? decl.id.name : undefined;
  }
  return undefined;
}

/** A located local declaration: a declaration node, or a variable declarator + its kind. */
interface LocalDeclaration {
  node: t.Declaration | t.VariableDeclarator;
  declKind?: "const" | "let" | "var";
}

/**
 * Find a top-level declaration in `ast` that declares `name` — a function,
 * class, interface, type, enum, namespace, or a single variable declarator
 * within a `const/let/var`. Used to attribute a bare `export { name }` to its
 * declaration so we can build a signature. Returns the first match.
 */
function findLocalDeclaration(ast: t.File, name: string): LocalDeclaration | undefined {
  for (const stmt of ast.program.body) {
    // Unwrap an export wrapper so `export const x = ...; export { x }` (rare but
    // legal) still resolves — and so a declaration that is itself exported and
    // ALSO listed in a separate `export {}` is found.
    const decl = t.isExportNamedDeclaration(stmt) && stmt.declaration ? stmt.declaration : stmt;
    if (t.isVariableDeclaration(decl)) {
      const declKind = decl.kind === "const" ? "const" : decl.kind === "let" ? "let" : "var";
      for (const d of decl.declarations) {
        if (t.isIdentifier(d.id) && d.id.name === name) {
          return { node: d, declKind };
        }
      }
      continue;
    }
    if (
      (t.isFunctionDeclaration(decl) ||
        t.isTSDeclareFunction(decl) ||
        t.isClassDeclaration(decl) ||
        t.isTSInterfaceDeclaration(decl) ||
        t.isTSTypeAliasDeclaration(decl) ||
        t.isTSEnumDeclaration(decl)) &&
      decl.id &&
      decl.id.name === name
    ) {
      return { node: decl as t.Declaration };
    }
  }
  return undefined;
}

/** The shape of the recursive `visit` closure, for handler signatures. */
type VisitFn = (
  file: string,
  nameFilter: Set<string> | undefined,
  renames: Map<string, string>,
  visited: Set<string>
) => void;

function renderMarkdown(data: {
  target: string;
  packageEntryPoints: string[];
  entries: EntrySurface[];
  totalSymbols: number;
  count: number;
}): string {
  const lines: string[] = [
    `# API surface: ${data.target}`,
    "",
    `${data.totalSymbols} public symbol(s) across ${data.entries.length} entry point(s)${
      data.count < data.totalSymbols ? ` (showing ${data.count})` : ""
    }.`,
    ""
  ];
  if (data.packageEntryPoints.length) {
    lines.push(`Declared package entries: ${data.packageEntryPoints.join(", ")}`, "");
  }
  for (const entry of data.entries) {
    lines.push(`## ${entry.entry}`);
    if (entry.symbols.length === 0) lines.push("_(no public symbols)_");
    for (const sym of entry.symbols) {
      const def = sym.exportKind === "default" ? " _(default)_" : "";
      const typ = sym.typeOnly ? " _(type)_" : "";
      const where = sym.declaredIn && sym.declaredIn !== entry.entry ? ` — from \`${sym.declaredIn}\`` : "";
      lines.push(`- \`${sym.kind}\` **${sym.name}**${def}${typ}: \`${sym.signature}\`${where}`);
      if (sym.members) {
        for (const m of sym.members) {
          const mods = [m.static ? "static" : "", m.optional ? "optional" : ""].filter(Boolean).join(" ");
          const modStr = mods ? `${mods} ` : "";
          lines.push(`    - ${modStr}\`${m.kind}\` \`${m.signature}\``);
        }
      }
    }
    if (entry.unresolved.length) {
      lines.push("", "_Unresolved re-exports (target outside scope):_");
      for (const u of entry.unresolved) {
        const which = u.kind === "named" && u.names ? ` { ${u.names.join(", ")} }` : " *";
        lines.push(`- \`export${which} from "${u.source}"\` in \`${u.from}\``);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
