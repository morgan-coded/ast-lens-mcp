/**
 * Symbol / outline / module extraction.
 *
 * Higher-level analysis built on the traverse helpers. These functions operate
 * on a single parsed AST and produce the structured shapes the tools return.
 */
import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import { spanOf } from "./parser.js";
import {
  classMemberSymbol,
  functionDisplayName,
  type FunctionLike,
  kindOfDeclaration,
  makeSymbol,
  modifiersOf,
  namesOfDeclaration,
  traverse
} from "./traverse.js";
import type {
  CallGraphEdge,
  CallGraphNode,
  ExportInfo,
  ImportInfo,
  ModuleSummary,
  OutlineNode,
  Span,
  SymbolInfo
} from "./types.js";

/** A statement that may sit at the top level of a Program or be export-wrapped. */
type TopLevel = t.Statement;

interface ExportContext {
  exported: boolean;
  exportKind: SymbolInfo["exportKind"];
}

/** Unwrap an export declaration to the inner declaration plus its export context. */
function unwrapExport(stmt: TopLevel): { inner: t.Declaration | undefined; ctx: ExportContext } {
  if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
    return { inner: stmt.declaration, ctx: { exported: true, exportKind: "named" } };
  }
  if (t.isExportDefaultDeclaration(stmt)) {
    const decl = stmt.declaration;
    if (t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl) || t.isTSInterfaceDeclaration(decl)) {
      return { inner: decl as t.Declaration, ctx: { exported: true, exportKind: "default" } };
    }
    return { inner: undefined, ctx: { exported: true, exportKind: "default" } };
  }
  if (t.isDeclaration(stmt)) {
    return { inner: stmt, ctx: { exported: false, exportKind: "none" } };
  }
  return { inner: undefined, ctx: { exported: false, exportKind: "none" } };
}

/**
 * Map a file's *local* declaration names to how they are exported via a bare
 * `export { a, b as c }` clause (no inline declaration, no `from` source).
 *
 * Keyed by the LOCAL name (`a`, `b`) because that is what a top-level
 * declaration is named in this file — callers match a declaration's own name
 * against this map. The exported (possibly renamed) name is preserved in
 * `exportedAs` so output can show `export { local as exportedAs }`.
 *
 * Re-exports with a `from` source (`export { x } from "./y"`) are skipped: they
 * do not correspond to a local declaration in this file.
 */
interface SpecifierExport {
  exportedAs: string;
  typeOnly: boolean;
}

function collectNamedSpecifierExports(program: t.Program): Map<string, SpecifierExport> {
  const map = new Map<string, SpecifierExport>();
  for (const stmt of program.body) {
    if (t.isExportNamedDeclaration(stmt) && !stmt.declaration && !stmt.source) {
      for (const spec of stmt.specifiers) {
        if (t.isExportSpecifier(spec)) {
          const local = spec.local.name;
          const exportedAs = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
          map.set(local, {
            exportedAs,
            typeOnly: stmt.exportKind === "type" || spec.exportKind === "type"
          });
        }
      }
    }
  }
  return map;
}

/**
 * List top-level + exported symbols in a file. Class/interface members are NOT
 * included here (that is what get_file_outline is for); this returns the flat
 * set of named module-level declarations.
 */
export function listSymbols(ast: t.File): SymbolInfo[] {
  const program = ast.program;
  const symbols: SymbolInfo[] = [];
  const specifierExports = collectNamedSpecifierExports(program);

  for (const stmt of program.body) {
    const { inner, ctx } = unwrapExport(stmt);
    if (!inner) {
      // `export default <expression>` with no name — represent as anonymous default.
      if (t.isExportDefaultDeclaration(stmt)) {
        symbols.push({
          name: "default",
          kind: "unknown",
          exported: true,
          exportKind: "default",
          span: spanOf(stmt)
        });
      }
      continue;
    }

    const kind = kindOfDeclaration(inner);
    if (!kind) continue;
    const names = namesOfDeclaration(inner);
    // Anonymous `export default class {}` / `export default function () {}`:
    // the declaration has no id, but it is still the module's default export.
    if (names.length === 0 && ctx.exportKind === "default") {
      symbols.push(makeSymbol("default", kind, inner, true, "default"));
      continue;
    }
    for (const name of names) {
      const exportedBySpecifier = specifierExports.has(name);
      const exported = ctx.exported || exportedBySpecifier;
      const exportKind = ctx.exported ? ctx.exportKind : exportedBySpecifier ? "named" : "none";
      symbols.push(makeSymbol(name, kind, inner, exported, exportKind));
    }
  }

  return symbols.sort((a, b) => a.span.start.line - b.span.start.line);
}

/** Build a hierarchical outline: module-level symbols, with class bodies expanded. */
export function fileOutline(ast: t.File): OutlineNode[] {
  const program = ast.program;
  const nodes: OutlineNode[] = [];
  const specifierExports = collectNamedSpecifierExports(program);

  for (const stmt of program.body) {
    const { inner, ctx } = unwrapExport(stmt);
    if (!inner) continue;
    const kind = kindOfDeclaration(inner);
    if (!kind) continue;

    const names = namesOfDeclaration(inner);
    // Anonymous `export default class {}` still gets an outline node named
    // "default" (with its members expanded below).
    const outlineNames = names.length === 0 && ctx.exportKind === "default" ? ["default"] : names;
    for (const name of outlineNames) {
      const isAnonDefault = names.length === 0;
      const exportedBySpecifier = !isAnonDefault && specifierExports.has(name);
      const exported = ctx.exported || exportedBySpecifier;
      const exportKind = ctx.exported ? ctx.exportKind : exportedBySpecifier ? "named" : "none";
      const node: OutlineNode = makeSymbol(name, kind, inner, exported, exportKind);

      if (t.isClassDeclaration(inner)) {
        const children: OutlineNode[] = [];
        for (const member of inner.body.body) {
          const sym = classMemberSymbol(member);
          if (sym) children.push(sym);
        }
        if (children.length > 0) {
          children.sort((a, b) => a.span.start.line - b.span.start.line);
          node.children = children;
        }
      } else if (t.isTSInterfaceDeclaration(inner)) {
        const children: OutlineNode[] = [];
        for (const member of inner.body.body) {
          const child = tsMemberSymbol(member);
          if (child) children.push(child);
        }
        if (children.length > 0) {
          children.sort((a, b) => a.span.start.line - b.span.start.line);
          node.children = children;
        }
      } else if (t.isTSEnumDeclaration(inner)) {
        const children: OutlineNode[] = inner.members.map((m) => ({
          name: t.isIdentifier(m.id) ? m.id.name : t.isStringLiteral(m.id) ? m.id.value : "<member>",
          kind: "property" as const,
          exported: false,
          exportKind: "none" as const,
          span: spanOf(m)
        }));
        if (children.length > 0) node.children = children;
      }

      nodes.push(node);
    }
  }

  return nodes.sort((a, b) => a.span.start.line - b.span.start.line);
}

/** Symbol info for a TS interface member (method signature / property signature). */
function tsMemberSymbol(member: t.TSTypeElement): OutlineNode | undefined {
  if (t.isTSMethodSignature(member)) {
    const name = keyName(member.key);
    if (name === undefined) return undefined;
    return { name, kind: "method", exported: false, exportKind: "none", span: spanOf(member) };
  }
  if (t.isTSPropertySignature(member)) {
    const name = keyName(member.key);
    if (name === undefined) return undefined;
    return { name, kind: "property", exported: false, exportKind: "none", span: spanOf(member) };
  }
  return undefined;
}

function keyName(key: t.Node): string | undefined {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  return undefined;
}

/** Summarize a module's imports, exports, and dependency specifiers. */
export function summarizeModule(ast: t.File, file: string): ModuleSummary {
  const program = ast.program;
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];
  const depSet = new Set<string>();

  for (const stmt of program.body) {
    // import ... from "x"
    if (t.isImportDeclaration(stmt)) {
      const source = stmt.source.value;
      depSet.add(source);
      const bindings = stmt.specifiers.map((spec) => {
        if (t.isImportDefaultSpecifier(spec)) {
          return { local: spec.local.name, imported: "default" };
        }
        if (t.isImportNamespaceSpecifier(spec)) {
          return { local: spec.local.name, imported: "*" };
        }
        const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
        return { local: spec.local.name, imported };
      });
      imports.push({
        source,
        bindings,
        typeOnly: stmt.importKind === "type",
        span: spanOf(stmt)
      });
      continue;
    }

    // export { ... } / export ... from "x" / export const/function/...
    if (t.isExportNamedDeclaration(stmt)) {
      if (stmt.source) depSet.add(stmt.source.value);
      if (stmt.declaration) {
        const kind = kindOfDeclaration(stmt.declaration);
        if (kind) {
          for (const name of namesOfDeclaration(stmt.declaration)) {
            exports.push({
              name,
              kind: "named",
              typeOnly: stmt.exportKind === "type",
              span: spanOf(stmt.declaration)
            });
          }
        }
      }
      for (const spec of stmt.specifiers) {
        if (t.isExportSpecifier(spec)) {
          const name = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
          exports.push({
            name,
            kind: "named",
            ...(stmt.source ? { source: stmt.source.value } : {}),
            typeOnly: stmt.exportKind === "type" || spec.exportKind === "type",
            span: spanOf(spec)
          });
        } else if (t.isExportNamespaceSpecifier(spec)) {
          // export * as ns from "x"
          exports.push({
            name: spec.exported.name,
            kind: "named",
            ...(stmt.source ? { source: stmt.source.value } : {}),
            typeOnly: stmt.exportKind === "type",
            span: spanOf(spec)
          });
        }
      }
      continue;
    }

    // export default ...
    if (t.isExportDefaultDeclaration(stmt)) {
      const decl = stmt.declaration;
      const name =
        (t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id ? decl.id.name : "default";
      exports.push({ name, kind: "default", typeOnly: false, span: spanOf(stmt) });
      continue;
    }

    // export * from "x"  (bare star re-export; `export * as ns` is an
    // ExportNamedDeclaration with an ExportNamespaceSpecifier, handled above).
    if (t.isExportAllDeclaration(stmt)) {
      depSet.add(stmt.source.value);
      exports.push({
        name: "*",
        kind: "named",
        source: stmt.source.value,
        typeOnly: stmt.exportKind === "type",
        span: spanOf(stmt)
      });
    }
  }

  // Dynamic import("x") and require("x") anywhere in the file contribute deps.
  collectDynamicDeps(ast, depSet);

  const dependencies = Array.from(depSet).sort();
  const localDependencies = dependencies.filter(isLocalSpecifier);
  const externalDependencies = dependencies.filter((d) => !isLocalSpecifier(d));

  return { file, imports, exports, dependencies, localDependencies, externalDependencies };
}

/** Walk for `import("x")` and `require("x")` calls and record their specifiers. */
function collectDynamicDeps(ast: t.File, depSet: Set<string>): void {
  const visit = (node: t.Node | null | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (t.isCallExpression(node)) {
      const callee = node.callee;
      const firstArg = node.arguments[0];
      const isRequire = t.isIdentifier(callee) && callee.name === "require";
      const isDynamicImport = t.isImport(callee);
      if ((isRequire || isDynamicImport) && firstArg && t.isStringLiteral(firstArg)) {
        depSet.add(firstArg.value);
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

/** A specifier is "local" when it is a relative or absolute path import. */
function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/");
}

/** A symbol a module exports, in a shape convenient for unused-export analysis. */
export interface ExportedSymbol {
  /** Public name (the exported, possibly-renamed name). */
  name: string;
  kind: ExportInfo["kind"];
  span: Span;
  /** True for a bare `export * from "..."` (no nameable binding to check). */
  reexport: boolean;
}

/**
 * List the names a module exports, for unused-export analysis.
 *
 * Re-exports that forward another module's binding (`export { x } from "./y"`)
 * are skipped: the symbol is not declared here, so "is it used" is a question
 * about the original module, not this file. A bare `export * from "..."` is
 * reported with `reexport: true` because it cannot be resolved to a name here.
 */
export function exportedSymbols(ast: t.File): ExportedSymbol[] {
  const summary = summarizeModule(ast, "");
  const out: ExportedSymbol[] = [];
  for (const exp of summary.exports) {
    if (exp.name === "*") {
      out.push({ name: "*", kind: exp.kind, span: exp.span, reexport: true });
      continue;
    }
    // `export { x } from "./y"` / `export * as ns from "./y"` forward another
    // module's binding; skip — they are not declared in this file.
    if (exp.source) continue;
    out.push({ name: exp.name, kind: exp.kind, span: exp.span, reexport: false });
  }
  return out;
}

/**
 * Names that this module forwards from ANOTHER module via a re-export
 * specifier — `export { a } from "./y"` yields the origin-side name `a`, and
 * `export { a as b } from "./y"` also yields `a` (the name as it exists in the
 * source module). Used to treat entry-point re-exports as reachability roots so
 * a symbol re-exported by a public entry point is not reported as unused.
 *
 * Bare `export * from "./y"` cannot be enumerated by name here and is omitted
 * (documented limitation of the name-based check).
 */
export function reexportedOriginNames(ast: t.File): string[] {
  const names: string[] = [];
  for (const stmt of ast.program.body) {
    if (t.isExportNamedDeclaration(stmt) && stmt.source) {
      for (const spec of stmt.specifiers) {
        if (t.isExportSpecifier(spec)) {
          names.push(spec.local.name);
        }
      }
    }
  }
  return names;
}

/**
 * Module specifiers this file forwards via a bare `export * from "./x"`. Each
 * such target re-exports ALL of the source module's symbols, so when the
 * forwarding file is a public entry point, the target module's exports are
 * transitively public API too. Returned as written (e.g. "./dynamic"); the
 * caller resolves them to concrete files. Named `export * as ns from "./x"`
 * binds a single namespace name (handled by reexportedOriginNames-style logic),
 * so only the unnamed `ExportAllDeclaration` is collected here.
 */
export function starReexportSources(ast: t.File): string[] {
  const out: string[] = [];
  for (const stmt of ast.program.body) {
    if (t.isExportAllDeclaration(stmt)) {
      out.push(stmt.source.value);
    }
  }
  return out;
}

/**
 * Count "real" usages of each name in `names` within one AST, where a real
 * usage is any identifier occurrence that is NOT a declaration site and NOT an
 * import/export binding. This mirrors find_references' classification but is
 * tuned for reachability: imports and re-export specifiers do not count as
 * "using" a symbol, only value/type/jsx references and call sites do.
 *
 * `tally` is mutated in place (name -> running count) so callers can accumulate
 * across many files.
 */
export function countNameUsages(ast: t.File, names: Set<string>, tally: Map<string, number>): void {
  if (names.size === 0) return;
  traverse(ast, {
    "Identifier|JSXIdentifier"(path) {
      const node = path.node as t.Identifier | t.JSXIdentifier;
      if (!names.has(node.name)) return;
      if (isNonUsageOccurrence(path as NodePath<t.Identifier | t.JSXIdentifier>)) return;
      tally.set(node.name, (tally.get(node.name) ?? 0) + 1);
    }
  });
}

/**
 * True when an identifier occurrence is a binding/declaration position rather
 * than a usage: declaration ids, import specifiers, export specifiers, and
 * object-member *keys* (which are property names, not references to a symbol).
 */
function isNonUsageOccurrence(path: NodePath<t.Identifier | t.JSXIdentifier>): boolean {
  const node = path.node;
  const parent = path.parent;

  // Declaration sites.
  if ((t.isFunctionDeclaration(parent) || t.isClassDeclaration(parent)) && parent.id === node) return true;
  if (
    (t.isTSInterfaceDeclaration(parent) ||
      t.isTSTypeAliasDeclaration(parent) ||
      t.isTSEnumDeclaration(parent) ||
      t.isTSDeclareFunction(parent)) &&
    (parent as { id?: t.Node }).id === node
  ) {
    return true;
  }
  if (t.isVariableDeclarator(parent) && parent.id === node) return true;

  // Import bindings (`import { X }`, `import X`, `import * as X`).
  if (
    t.isImportSpecifier(parent) ||
    t.isImportDefaultSpecifier(parent) ||
    t.isImportNamespaceSpecifier(parent)
  ) {
    return true;
  }

  // Export specifiers: `export { X }` / `export { X as Y }`. Neither the local
  // nor the exported identifier counts as a usage of the symbol.
  if (t.isExportSpecifier(parent) || t.isExportNamespaceSpecifier(parent)) return true;

  // Object/class member *keys* are names, not references — unless computed.
  if (
    (t.isObjectProperty(parent) ||
      t.isObjectMethod(parent) ||
      t.isClassProperty(parent) ||
      t.isClassMethod(parent) ||
      t.isClassPrivateProperty(parent) ||
      t.isClassPrivateMethod(parent) ||
      t.isTSPropertySignature(parent) ||
      t.isTSMethodSignature(parent)) &&
    (parent as { key?: t.Node; computed?: boolean }).key === node &&
    !(parent as { computed?: boolean }).computed
  ) {
    return true;
  }

  // Non-computed member access property (`obj.foo` — `foo` is not a free ref).
  if (
    (t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) &&
    parent.property === node &&
    !parent.computed
  ) {
    return true;
  }

  return false;
}

/**
 * Build a function call graph for a single file.
 *
 * Nodes are every function-like definition (declarations, expressions, arrows,
 * class/object methods) with a stable id. Edges connect a call site to the
 * enclosing function node (or `null` for top-level calls) and carry the callee
 * name as written; resolution of the callee to a node id is left to the caller,
 * which has the cross-file picture. Callee names are resolved with the same
 * best-effort logic search_ast uses (bare names + member paths, incl. optional
 * chaining).
 */
export function buildFileCallGraph(
  ast: t.File,
  file: string
): { nodes: CallGraphNode[]; edges: CallGraphEdge[] } {
  const nodes: CallGraphNode[] = [];
  const edges: CallGraphEdge[] = [];

  // Map each function-like NodePath to its node id so a call site can find its
  // nearest enclosing function.
  const idByFnNode = new Map<t.Node, string>();

  traverse(ast, {
    Function(path) {
      const fnPath = path as NodePath<FunctionLike>;
      const { name, kind } = functionDisplayName(fnPath);
      const span = spanOf(fnPath.node);
      const id = `${file}#${name}@${span.start.line}`;
      idByFnNode.set(fnPath.node, id);
      nodes.push({ id, name, file, kind, span });
    },
    "CallExpression|OptionalCallExpression|NewExpression"(path) {
      const node = path.node as t.CallExpression | t.OptionalCallExpression | t.NewExpression;
      const callee = calleeName(node.callee as t.Expression);
      if (!callee) return;
      const from = enclosingFunctionId(path, idByFnNode);
      edges.push({ from, callee, to: null, file, span: spanOf(node) });
    }
  });

  return { nodes, edges };
}

/** Walk up from a call site to the id of the nearest enclosing function node. */
function enclosingFunctionId(path: NodePath, idByFnNode: Map<t.Node, string>): string | null {
  let current: NodePath | null = path.parentPath;
  while (current) {
    const id = idByFnNode.get(current.node);
    if (id !== undefined) return id;
    current = current.parentPath;
  }
  return null;
}

/** Build a dotted name for a callee expression (bare name or member path),
 * handling optional chaining. Mirrors the resolver in search_ast. */
function calleeName(node: t.Expression | t.V8IntrinsicIdentifier | t.PrivateName): string | undefined {
  if (t.isIdentifier(node)) return node.name;
  if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed) {
    const obj = calleeName(node.object as t.Expression);
    const prop = t.isIdentifier(node.property) ? node.property.name : undefined;
    if (obj && prop) return `${obj}.${prop}`;
    if (prop) return prop;
  }
  return undefined;
}

// Re-export modifiersOf for tools that build symbols directly.
export { modifiersOf };
