/**
 * Parsing + caching layer.
 *
 * Wraps @babel/parser with sensible plugin selection per file extension and an
 * mtime-based cache so re-querying the same file within a session is cheap.
 * Parse failures never throw out of here; callers get a structured result and
 * decide how to surface it.
 */
import { parse, type ParserOptions } from "@babel/parser";
import type { File } from "@babel/types";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Position, Span } from "./types.js";

export interface ParsedFile {
  /** Absolute path to the file. */
  file: string;
  /** Parsed Babel AST. */
  ast: File;
  /** Raw source text (used for snippet extraction). */
  code: string;
}

export interface ParseFailure {
  file: string;
  error: {
    message: string;
    position?: Position;
  };
}

export type ParseResult =
  | { ok: true; value: ParsedFile }
  | { ok: false; error: ParseFailure };

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

/** Whether a path has an extension this server can parse. */
export function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Build Babel parser options appropriate for the given file extension.
 *
 * We parse in a permissive mode: every plugin we might need is enabled so the
 * server can handle modern TS/JSX without configuration. We never type-check —
 * this is purely syntactic. */
export function parserOptionsFor(filePath: string): ParserOptions {
  const ext = path.extname(filePath).toLowerCase();
  const isTs = ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts";
  const isJsx = ext === ".tsx" || ext === ".jsx" || ext === ".js" || ext === ".mjs" || ext === ".cjs";

  const plugins: ParserOptions["plugins"] = [
    "classProperties",
    "classPrivateProperties",
    "classPrivateMethods",
    "decorators-legacy",
    "dynamicImport",
    "exportDefaultFrom",
    "exportNamespaceFrom",
    "importAssertions",
    "objectRestSpread",
    "optionalChaining",
    "nullishCoalescingOperator",
    "topLevelAwait"
  ];

  if (isTs) plugins.push("typescript");
  // For plain .js/.jsx we still allow JSX (common in React projects without TS).
  if (isJsx) plugins.push("jsx");

  return {
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowUndeclaredExports: true,
    errorRecovery: false,
    ranges: true,
    plugins
  };
}

/** Parse a source string. Pure (no I/O); used by tests and the file loader. */
export function parseCode(code: string, filePath: string): ParseResult {
  try {
    const ast = parse(code, parserOptionsFor(filePath));
    return { ok: true, value: { file: filePath, ast, code } };
  } catch (err) {
    // Babel throws SyntaxError-like objects with a `loc` { line, column }.
    const anyErr = err as { message?: string; loc?: { line: number; column: number } };
    const position: Position | undefined = anyErr.loc
      ? { line: anyErr.loc.line, column: anyErr.loc.column + 1 }
      : undefined;
    return {
      ok: false,
      error: {
        file: filePath,
        error: {
          message: anyErr.message ?? "Unknown parse error",
          position
        }
      }
    };
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: ParsedFile;
}

/**
 * An in-memory parse cache keyed by absolute path, invalidated when a file's
 * mtime or size changes. Bounded by a simple max-entry cap with FIFO eviction
 * so a long-running server doesn't grow without limit.
 */
export class ParserCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = 2000) {}

  /** Read + parse a file from disk, using the cache when the file is unchanged. */
  async load(filePath: string): Promise<ParseResult> {
    const abs = path.resolve(filePath);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      return {
        ok: false,
        error: {
          file: abs,
          error: { message: `Cannot stat file: ${(err as Error).message}` }
        }
      };
    }

    if (!stat.isFile()) {
      return {
        ok: false,
        error: { file: abs, error: { message: "Path is not a file" } }
      };
    }

    const cached = this.cache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { ok: true, value: cached.parsed };
    }

    let code: string;
    try {
      code = await fs.readFile(abs, "utf8");
    } catch (err) {
      return {
        ok: false,
        error: {
          file: abs,
          error: { message: `Cannot read file: ${(err as Error).message}` }
        }
      };
    }

    const result = parseCode(code, abs);
    if (result.ok) {
      this.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, parsed: result.value });
    }
    return result;
  }

  private set(key: string, entry: CacheEntry): void {
    if (!this.cache.has(key)) {
      this.order.push(key);
      while (this.order.length > this.maxEntries) {
        const evict = this.order.shift();
        if (evict !== undefined) this.cache.delete(evict);
      }
    }
    this.cache.set(key, entry);
  }

  clear(): void {
    this.cache.clear();
    this.order.length = 0;
  }

  get size(): number {
    return this.cache.size;
  }
}

/** Convert a Babel node's loc into our 1-based Span. Columns are normalized to
 * 1-based to match editor display. Falls back to a zeroed span if loc is absent. */
export function spanOf(node: { loc?: { start: { line: number; column: number }; end: { line: number; column: number } } | null }): Span {
  const loc = node.loc;
  if (!loc) {
    return { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
  }
  return {
    start: { line: loc.start.line, column: loc.start.column + 1 },
    end: { line: loc.end.line, column: loc.end.column + 1 }
  };
}
