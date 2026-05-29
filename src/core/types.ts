/**
 * Shared type definitions for ast-lens-mcp.
 *
 * These types describe the structured JSON that tools return. Keeping them in
 * one place lets tools, the parser, and the tests agree on a single shape.
 */

/** A 1-based source position. Babel reports lines 1-based and columns 0-based; we
 * normalize columns to 1-based here so output is human-friendly and matches what
 * editors display. */
export interface Position {
  line: number;
  column: number;
}

/** A source span with start and end positions plus an absolute character index range. */
export interface Span {
  start: Position;
  end: Position;
}

/** The kind of a top-level or exported symbol. */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "let"
  | "var"
  | "variable"
  | "method"
  | "property"
  | "getter"
  | "setter"
  | "namespace"
  | "unknown";

/** How a symbol leaves a module, if at all. */
export type ExportKind = "named" | "default" | "none";

/** A symbol discovered in a file. */
export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  exportKind: ExportKind;
  /** True for `async function`/`async () => {}`/async methods. */
  async?: boolean;
  /** True for generator functions/methods. */
  generator?: boolean;
  /** True for `static` class members. */
  static?: boolean;
  /** True for `abstract` class members / classes. */
  abstract?: boolean;
  span: Span;
}

/** A node in a hierarchical file outline (e.g. class -> methods). */
export interface OutlineNode extends SymbolInfo {
  children?: OutlineNode[];
}

/** A single reference (identifier usage) to a symbol. */
export interface ReferenceInfo {
  file: string;
  span: Span;
  /** A short, single-line snippet of the source at the reference site. */
  snippet: string;
  /** Best-effort classification of how the identifier is used. */
  context: "call" | "import" | "declaration" | "type" | "jsx" | "reference";
}

/** An AST query match. */
export interface MatchInfo {
  file: string;
  span: Span;
  /** The matched node's Babel type (e.g. "CallExpression"). */
  nodeType: string;
  /** A short, single-line snippet of the source at the match site. */
  snippet: string;
  /** Optional extra detail specific to the query (e.g. the callee name, the TODO text). */
  detail?: string;
}

/** Per-function complexity measurement. */
export interface ComplexityInfo {
  name: string;
  kind: SymbolKind;
  span: Span;
  /** Cyclomatic complexity (decision points + 1). */
  complexity: number;
  /** Lines of code spanned by the function body (inclusive). */
  loc: number;
  /** Number of declared parameters. */
  params: number;
  /** True when complexity meets or exceeds the requested threshold. */
  overThreshold: boolean;
}

/** A single import binding within a module. */
export interface ImportInfo {
  /** The module being imported from (e.g. "react", "./utils"). */
  source: string;
  /** Local names bound by this import statement. */
  bindings: Array<{
    local: string;
    /** The imported name; "default" for default imports, "*" for namespace imports. */
    imported: string;
  }>;
  typeOnly: boolean;
  span: Span;
}

/** A single export from a module. */
export interface ExportInfo {
  name: string;
  kind: ExportKind;
  /** For re-exports (`export { x } from "./y"`), the source module. */
  source?: string;
  typeOnly: boolean;
  span: Span;
}

/** Result of summarizing a module's imports/exports/dependencies. */
export interface ModuleSummary {
  file: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  /** Distinct module specifiers this file depends on (imports + re-exports + dynamic imports + require). */
  dependencies: string[];
  /** Dependencies split into local (relative/absolute paths) and external (bare specifiers). */
  localDependencies: string[];
  externalDependencies: string[];
}

/** A file that failed to parse, surfaced to the caller instead of throwing. */
export interface ParseErrorInfo {
  file: string;
  message: string;
  position?: Position;
}
