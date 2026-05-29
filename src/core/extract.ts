/**
 * Symbol / outline / module extraction.
 *
 * Higher-level analysis built on the traverse helpers. These functions operate
 * on a single parsed AST and produce the structured shapes the tools return.
 */
import * as t from "@babel/types";
import { spanOf } from "./parser.js";
import {
  classMemberSymbol,
  kindOfDeclaration,
  makeSymbol,
  modifiersOf,
  namesOfDeclaration
} from "./traverse.js";
import type {
  ExportInfo,
  ImportInfo,
  ModuleSummary,
  OutlineNode,
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

/** Names exported via `export { a, b as c }` (without an inline declaration). */
function collectNamedSpecifierExports(program: t.Program): Map<string, ExportInfo> {
  const map = new Map<string, ExportInfo>();
  for (const stmt of program.body) {
    if (t.isExportNamedDeclaration(stmt) && !stmt.declaration) {
      for (const spec of stmt.specifiers) {
        if (t.isExportSpecifier(spec)) {
          const name = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
          map.set(name, {
            name,
            kind: stmt.source ? "named" : "named",
            ...(stmt.source ? { source: stmt.source.value } : {}),
            typeOnly: stmt.exportKind === "type" || spec.exportKind === "type",
            span: spanOf(spec)
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
    for (const name of names) {
      const exportedBySpecifier = specifierExports.has(name);
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

// Re-export modifiersOf for tools that build symbols directly.
export { modifiersOf };
