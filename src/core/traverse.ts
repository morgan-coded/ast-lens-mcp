/**
 * Shared AST traversal helpers.
 *
 * The functions here are the reusable Babel layer that every tool composes:
 * extracting source snippets, classifying declarations into symbols, resolving
 * how a declaration is exported, and computing cyclomatic complexity. Keeping
 * this logic in one place keeps the individual tools thin and consistent.
 */
import _traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { ComplexityInfo, SymbolInfo, SymbolKind } from "./types.js";
import { spanOf } from "./parser.js";

// @babel/traverse ships a CJS default export that interop-imports as an object
// under ESM in some toolchains. Normalize to the callable.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

export { traverse };

/** Extract a trimmed, single-line snippet for the node's first source line. */
export function snippetOf(code: string, node: t.Node, maxLen = 200): string {
  const loc = node.loc;
  if (!loc) return "";
  const lines = code.split(/\r?\n/);
  const line = lines[loc.start.line - 1] ?? "";
  const trimmed = line.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

/** Number of source lines a node spans (inclusive). */
export function locOf(node: t.Node): number {
  const loc = node.loc;
  if (!loc) return 0;
  return loc.end.line - loc.start.line + 1;
}

/** Classify a function-like node's kind. */
function functionKind(node: t.Node): SymbolKind {
  if (t.isClassMethod(node) || t.isClassPrivateMethod(node) || t.isObjectMethod(node)) {
    if (node.kind === "get") return "getter";
    if (node.kind === "set") return "setter";
    return "method";
  }
  return "function";
}

/**
 * Map a declaration node to a SymbolKind. Returns undefined for nodes that do
 * not introduce a named symbol we care about.
 */
export function kindOfDeclaration(node: t.Node): SymbolKind | undefined {
  if (t.isFunctionDeclaration(node)) return "function";
  // Ambient/overload signatures: `declare function f(): void`,
  // `export declare function f(): void`, and TS function overload signatures
  // parse as TSDeclareFunction (no body). They still name a module symbol.
  if (t.isTSDeclareFunction(node)) return "function";
  if (t.isClassDeclaration(node)) return "class";
  if (t.isTSInterfaceDeclaration(node)) return "interface";
  if (t.isTSTypeAliasDeclaration(node)) return "type";
  if (t.isTSEnumDeclaration(node)) return "enum";
  if (t.isTSModuleDeclaration(node)) return "namespace";
  if (t.isVariableDeclaration(node)) {
    return node.kind === "const" ? "const" : node.kind === "let" ? "let" : "var";
  }
  return undefined;
}

/** Get the declared name(s) for a declaration node. Variable declarations can
 * bind multiple identifiers (incl. destructuring patterns). */
export function namesOfDeclaration(node: t.Node): string[] {
  if (
    t.isFunctionDeclaration(node) ||
    t.isTSDeclareFunction(node) ||
    t.isClassDeclaration(node) ||
    t.isTSInterfaceDeclaration(node) ||
    t.isTSTypeAliasDeclaration(node) ||
    t.isTSEnumDeclaration(node)
  ) {
    return node.id ? [node.id.name] : [];
  }
  if (t.isTSModuleDeclaration(node)) {
    return t.isIdentifier(node.id) ? [node.id.name] : t.isStringLiteral(node.id) ? [node.id.value] : [];
  }
  if (t.isVariableDeclaration(node)) {
    const names: string[] = [];
    for (const decl of node.declarations) {
      collectPatternNames(decl.id, names);
    }
    return names;
  }
  return [];
}

/** Recursively collect bound identifier names from a binding pattern. */
function collectPatternNames(node: t.LVal | t.Pattern, out: string[]): void {
  if (t.isIdentifier(node)) {
    out.push(node.name);
  } else if (t.isObjectPattern(node)) {
    for (const prop of node.properties) {
      if (t.isObjectProperty(prop)) {
        collectPatternNames(prop.value as t.LVal, out);
      } else if (t.isRestElement(prop)) {
        collectPatternNames(prop.argument as t.LVal, out);
      }
    }
  } else if (t.isArrayPattern(node)) {
    for (const el of node.elements) {
      if (el) collectPatternNames(el as t.LVal, out);
    }
  } else if (t.isAssignmentPattern(node)) {
    collectPatternNames(node.left as t.LVal, out);
  } else if (t.isRestElement(node)) {
    collectPatternNames(node.argument as t.LVal, out);
  }
}

/** Detect modifier flags on a node for richer symbol info. */
export function modifiersOf(node: t.Node): Pick<SymbolInfo, "async" | "generator" | "static" | "abstract"> {
  const mods: Pick<SymbolInfo, "async" | "generator" | "static" | "abstract"> = {};
  if ("async" in node && (node as { async?: boolean }).async) mods.async = true;
  if ("generator" in node && (node as { generator?: boolean }).generator) mods.generator = true;
  if ("static" in node && (node as { static?: boolean }).static) mods.static = true;
  if ("abstract" in node && (node as { abstract?: boolean }).abstract) mods.abstract = true;
  return mods;
}

/**
 * Build a SymbolInfo for a single named declaration occurrence.
 * `exported`/`exportKind` are supplied by the caller, which knows the export
 * context (a declaration can be wrapped by `export`/`export default`).
 */
export function makeSymbol(
  name: string,
  kind: SymbolKind,
  node: t.Node,
  exported: boolean,
  exportKind: SymbolInfo["exportKind"]
): SymbolInfo {
  return {
    name,
    kind,
    exported,
    exportKind,
    ...modifiersOf(node),
    span: spanOf(node)
  };
}

/** Determine the kind for a class member node and its name (if statically known). */
export function classMemberSymbol(node: t.Node): SymbolInfo | undefined {
  if (t.isClassMethod(node) || t.isClassPrivateMethod(node)) {
    const name = memberName(node);
    if (name === undefined) return undefined;
    if (node.kind === "constructor") {
      return { name, kind: "method", exported: false, exportKind: "none", ...modifiersOf(node), span: spanOf(node) };
    }
    return { name, kind: functionKind(node), exported: false, exportKind: "none", ...modifiersOf(node), span: spanOf(node) };
  }
  if (t.isClassProperty(node) || t.isClassPrivateProperty(node)) {
    const name = memberName(node);
    if (name === undefined) return undefined;
    return { name, kind: "property", exported: false, exportKind: "none", ...modifiersOf(node), span: spanOf(node) };
  }
  return undefined;
}

/** Resolve a member/property key to a string name when statically known. */
export function memberName(node: t.Node): string | undefined {
  const key = (node as { key?: t.Node }).key;
  if (!key) return undefined;
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  if (t.isPrivateName(key)) return `#${key.id.name}`;
  return undefined;
}

/** The set of node types that constitute a function scope for complexity. */
export type FunctionLike =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ClassMethod
  | t.ClassPrivateMethod
  | t.ObjectMethod;

export function isFunctionLike(node: t.Node): node is FunctionLike {
  return (
    t.isFunctionDeclaration(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isClassMethod(node) ||
    t.isClassPrivateMethod(node) ||
    t.isObjectMethod(node)
  );
}

/**
 * Compute cyclomatic complexity for a single function node by counting decision
 * points within it WITHOUT descending into nested functions (those are measured
 * separately). The metric is the classic McCabe count: 1 + number of branching
 * constructs (if, loop, case, catch, ternary, logical &&/||/??, optional-chain).
 */
export function cyclomaticComplexity(fnPath: NodePath<FunctionLike>): number {
  let complexity = 1;
  const fnNode = fnPath.node;

  fnPath.traverse({
    // Stop at nested function scopes — they get their own measurement.
    Function(inner) {
      if (inner.node !== fnNode) inner.skip();
    },
    IfStatement() {
      complexity++;
    },
    ForStatement() {
      complexity++;
    },
    ForInStatement() {
      complexity++;
    },
    ForOfStatement() {
      complexity++;
    },
    WhileStatement() {
      complexity++;
    },
    DoWhileStatement() {
      complexity++;
    },
    SwitchCase(casePath) {
      // Count only non-default cases (default is the fall-through, not a branch).
      if (casePath.node.test) complexity++;
    },
    CatchClause() {
      complexity++;
    },
    ConditionalExpression() {
      complexity++;
    },
    LogicalExpression(logical) {
      // &&, ||, ?? each add a branch.
      if (logical.node.operator === "&&" || logical.node.operator === "||" || logical.node.operator === "??") {
        complexity++;
      }
    },
    OptionalMemberExpression() {
      complexity++;
    },
    OptionalCallExpression() {
      complexity++;
    }
  });

  return complexity;
}

/** A readable display name for a function-like node used in complexity output. */
export function functionDisplayName(path: NodePath<FunctionLike>): { name: string; kind: SymbolKind } {
  const node = path.node;

  if (t.isFunctionDeclaration(node) && node.id) {
    return { name: node.id.name, kind: "function" };
  }
  if (t.isClassMethod(node) || t.isClassPrivateMethod(node) || t.isObjectMethod(node)) {
    const name = memberName(node) ?? "<anonymous>";
    return { name, kind: functionKind(node) };
  }

  // Function/arrow expressions: try to recover a name from the binding context.
  const parent = path.parent;
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
    return { name: parent.id.name, kind: "function" };
  }
  if (t.isObjectProperty(parent) && (t.isIdentifier(parent.key) || t.isStringLiteral(parent.key))) {
    const name = t.isIdentifier(parent.key) ? parent.key.name : parent.key.value;
    return { name, kind: "function" };
  }
  if (t.isClassProperty(parent)) {
    const name = memberName(parent) ?? "<anonymous>";
    return { name, kind: "method" };
  }
  if (
    (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) &&
    "id" in node &&
    node.id
  ) {
    return { name: node.id.name, kind: "function" };
  }
  return { name: "<anonymous>", kind: "function" };
}

/** Compute complexity for every function-like node in an AST, with threshold flag. */
export function analyzeAllFunctions(ast: t.File, threshold: number): ComplexityInfo[] {
  const results: ComplexityInfo[] = [];
  traverse(ast, {
    Function(path) {
      const fnPath = path as NodePath<FunctionLike>;
      const { name, kind } = functionDisplayName(fnPath);
      const complexity = cyclomaticComplexity(fnPath);
      results.push({
        name,
        kind,
        span: spanOf(fnPath.node),
        complexity,
        loc: locOf(fnPath.node),
        params: fnPath.node.params.length,
        overThreshold: complexity >= threshold
      });
    }
  });
  return results;
}
